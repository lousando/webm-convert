#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

import { parse as parseFlags } from "std/flags/mod.ts";
import { wait } from "wait";
import { ensureDir } from "std/fs/mod.ts";
import { parse as parsePath, ParsedPath } from "std/path/mod.ts";
import { SEP } from "std/path/separator.ts";
import Duration from "durationjs";
import { Database } from "aloedb";

const configFile = `${Deno.env.get("HOME")}/.webm-convert.json`;

interface AppConfig {
  version: number;
  pushover_token: string;
  pushover_users: Array<string>;
}

const configDB = new Database<AppConfig>({
  path: configFile,
  pretty: true,
  optimize: false, // does not batch saves and allows for #save to wait on disk write
});

const currentConfigFileVersion = 2;

// find the correct config version
const config = await configDB.findOne({
  version: currentConfigFileVersion,
});

// no config, create the initial config
if (config === null) {
  console.log(
    `No version ${currentConfigFileVersion} config found, creating a config...`,
  );
  await configDB.insertOne({
    version: currentConfigFileVersion,
    pushover_token: "",
    pushover_users: [""],
  });
  await configDB.save(); // make sure this is written to disk before continuing
  console.log(
    `Config saved to ${configFile}. Restart program for changes to take effect.\n`,
  );
}

try {
  // check if ffmpeg is installed
  await new Deno.Command("ffmpeg").output();
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    console.error(
      `Could not find "ffmpeg". Please install it to use this program.`,
    );
  } else {
    console.error(error);
  }

  Deno.exit(1);
}

const args = parseFlags(Deno.args, {
  stopEarly: true, // populates "_"
});

const filesToConvert: Array<ParsedPath> = args._.map((f) =>
  parsePath(String(f))
);

function showHelpAndExit() {
  console.log(
    `Usage: 
        webm-convert <input_file_1> [input_file_2]...
    `,
  );
  Deno.exit(1);
}

if (filesToConvert.length == 0) {
  showHelpAndExit();
}

const spinner = wait("Conversion starting in 5 seconds...").start();

Deno.addSignalListener("SIGINT", () => {
  spinner.clear(); // prevent weird console cursor on exit
  spinner.info("Conversion interrupted.");
  Deno.exit(130);
});

// wait a bit
await new Promise((resolve) => setTimeout(resolve, 5000));

spinner.clear();
spinner.info(
  `${filesToConvert.length} files will be converted.`,
);

const outputDirectory = "Converted";

await ensureDir(`${outputDirectory}`); // make empty dist directory

let totalConversionDurationInSeconds = 0;

for (let i = 0; i < filesToConvert.length; i++) {
  spinner.start();

  const file = filesToConvert[i];
  const ogFileName = file.dir === ""
    ? `./${file.base}`
    : `${file.dir}${SEP}${file.base}`;
  const titleName = file.name;
  const prettyFileIndex = i + 1;

  const fileInfo = await Deno.stat(ogFileName);

  if (fileInfo.isDirectory) {
    // skip this
    continue;
  }

  spinner.text = `Checking integrity of ${ogFileName}`;

  const inputFileIntegrityError = await hasIntegrityError(ogFileName);
  if (inputFileIntegrityError) {
    const errorMessage = `ERROR: Integrity issue with ${ogFileName}`;
    spinner.fail(errorMessage);
    await sendPushoverMessage(errorMessage, true);
    continue;
  }

  const videoHeightProcess = await new Deno.Command("ffprobe", {
    args: [
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=height",
      "-of",
      "csv=s=x:p=0",
      ogFileName,
    ],
  }).output();

  if (videoHeightProcess.code !== 0) {
    console.error(
      `%cFailed to get video height for ${ogFileName}`,
      "color: red",
    );
    Deno.exit(videoHeightProcess.code);
  }

  const heightResolutionString = (new TextDecoder()).decode(videoHeightProcess.stdout).replace(/\D/ig, '');
  const heightResolution = Number(heightResolutionString);

  const { options: resolutionOptions, matchedResolution } =
    findResolutionOptions(
      heightResolution,
    );

  let conversionDurationInSeconds = 0;
  const conversionInterval = setInterval(() => {
    spinner.text = `[File ${prettyFileIndex} of ${filesToConvert.length}] [${
      prettyDuration(conversionDurationInSeconds)
    }] [${matchedResolution}p] Converting: ${titleName}...`;
    conversionDurationInSeconds++;
    totalConversionDurationInSeconds++;
  }, 1000);

  // additional options
  // ====================
  // "-fflags +genpts" - add this to regenerate packet timestamps
  //    (in case of error "Can't write packet with unknown timestamp")
  // "-loglevel error" - only show errors
  // "-b:v 3000k -bufsize 3000k" - set the video bitrate to 3Mbs:
  // "-ac 2" - sets 2 audio channels
  // "-an" - no audio

  const outputFileName = `./${outputDirectory}${SEP}${titleName}.webm`;

  const conversionProcess = await new Deno.Command("ffmpeg", {
    args: [
      "-i",
      ogFileName,
      "-y", // overwrite output files

      "-sn", // no subtitles

      // no title
      "-metadata",
      "title=",

      // copy all streams
      "-map",
      "0",

      "-ac",
      "8",

      "-b:v",
      "0",

      "-speed",
      "4",

      "-frame-parallel",
      "1",

      "-auto-alt-ref",
      "1",

      "-lag-in-frames",
      "25",
      ...resolutionOptions,
      outputFileName,
    ],
  }).output();

  if (conversionProcess.code !== 0) {
    const errorMessage = `ERROR: Failed to convert ${outputFileName}`;
    spinner.fail(errorMessage);
    await sendPushoverMessage(errorMessage, true);
    continue;
  }

  spinner.text = `Checking integrity of ${outputFileName}`;
  const outputFileIntegrityError = await hasIntegrityError(outputFileName);
  if (outputFileIntegrityError) {
    const errorMessage = `ERROR: Integrity issue with ${outputFileName}`;
    spinner.fail(errorMessage);
    await sendPushoverMessage(errorMessage, true);
    continue;
  }

  spinner.stop(); // stop before clearing interval so spinner doesn't get stuck
  clearInterval(conversionInterval);

  const successMessage = `Done converting: ${titleName} (Took ${
    prettyDuration(conversionDurationInSeconds)
  })`;

  spinner.succeed(successMessage);

  await sendPushoverMessage(successMessage);
}

const doneMessage = `Finished converting ${filesToConvert.length} files (Took ${
  prettyDuration(totalConversionDurationInSeconds)
}).`;

spinner.succeed(doneMessage);
await sendPushoverMessage(doneMessage);

// utility functions
// ===================

function prettyDuration(durationInSeconds = 0) {
  return new Duration(durationInSeconds * 1000).stringify(
    ["h", "s", "m"],
    true,
  );
}

async function sendPushoverMessage(message = "", isError = false) {
  if (
    !config?.pushover_token ||
    !config?.pushover_users?.length
  ) {
    console.info(
      `"pushover_token" or "pushover_users" is not set in ${configFile}`,
    );
    return;
  }

  await Promise.all(config.pushover_users.map(async (user) => {
    const pushoverBody = new URLSearchParams();
    pushoverBody.append("token", config?.pushover_token);
    pushoverBody.append("user", user);
    pushoverBody.append("message", message);

    if (isError) {
      pushoverBody.append("sound", "intermission");
    }

    await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: pushoverBody,
    });
  }));
}

async function hasIntegrityError(fileName: string) {
  const integrityCheckProcess = await new Deno.Command("ffmpeg", {
    args: [
      "-loglevel",
      "error",
      "-i",
      fileName,
      "-f",
      "null",
      "-map",
      "0:1",
      "-",
    ],
  }).output();

  return (new TextDecoder().decode(integrityCheckProcess.stderr))?.length > 0;
}

function findResolutionOptions(heightResolution: number): {
  matchedResolution: number;
  options: Array<string>;
} {
  //  configure resolution
  // ===============================================
  switch (heightResolution) {
    case 360:
      // 360p - CRF 36 / -tile-columns 1 / -threads 4
      return {
        matchedResolution: 360,
        options: [
          "-crf",
          "36",
          "-tile-columns",
          "1",
          "-threads",
          "4",
        ],
      };
    case 480:
      // 480p - CRF 33 / -tile-columns 1 / -threads 4
      return {
        matchedResolution: 480,
        options: [
          "-crf",
          "33",
          "-tile-columns",
          "1",
          "-threads",
          "4",
        ],
      };
    case 720:
      // 720p - CRF 32 / -tile-columns 2 / -threads 8
      return {
        matchedResolution: 720,
        options: [
          "-crf",
          "32",
          "-tile-columns",
          "2",
          "-threads",
          "8",
        ],
      };
    case 1080:
      // 1080p - CRF 31 / -tile-columns 2 / -threads 8
      return {
        matchedResolution: 1080,
        options: [
          "-crf",
          "31",
          "-tile-columns",
          "2",
          "-threads",
          "8",
        ],
      };
    default: {
      const availableResolutions = [
        360,
        480,
        720,
        1080,
      ];
      const deltas = [
        ...availableResolutions,
      ].map((r) => Math.abs(r - heightResolution));
      const lowest = Math.min(...deltas);
      const matchedResolution = availableResolutions[deltas.indexOf(lowest)];
      return findResolutionOptions(matchedResolution);
    }
  }
  // ===============================================
}
