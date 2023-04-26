#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

import { parse } from "https://deno.land/std@0.135.0/flags/mod.ts";
import { wait } from "https://deno.land/x/wait@0.1.12/mod.ts";
import { ensureDir } from "https://deno.land/std@0.135.0/fs/mod.ts";
import {
  parse as parsePath,
  ParsedPath,
} from "https://deno.land/std@0.135.0/path/mod.ts";
import Duration from "https://deno.land/x/durationjs@v2.3.2/mod.ts";
import { Database } from "https://deno.land/x/aloedb@0.9.0/mod.ts";

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
    pushover_user: [""],
  });
  await configDB.save(); // make sure this is written to disk before continuing
  console.log(
    `Config saved to ${configFile}. Restart program for changes to take effect.\n`,
  );
}

try {
  // check if ffmpeg is installed
  const ffmpegCheck = Deno.run({
    stdout: "null", // ignore this program's output
    stdin: "null", // ignore this program's input
    stderr: "null", // ignore this program's input
    cmd: ["ffmpeg"],
  });

  await ffmpegCheck.status(); // wait for process to stop
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

const args = parse(Deno.args, {
  stopEarly: true, // populates "_"
  alias: {
    "r": "resolution",
  },
  string: [
    "resolution",
  ],
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
spinner.info(`${filesToConvert.length} files will be converted.`);

let totalConversionDurationInSeconds = 0;

for (let i = 0; i < filesToConvert.length; i++) {
  spinner.start();

  const file = filesToConvert[i];
  const titleName = file.name;
  const prettyFileIndex = i + 1;

  spinner.text = `Checking integrity of ${file.dir + file.base}`;
  const inputFileIntegrityError = await hasIntegrityError(file.dir + file.base);
  if (inputFileIntegrityError) {
    const errorMessage = `ERROR: Integrity issue with ${file.dir + file.base}`;
    spinner.fail(errorMessage);
    await sendPushoverMessage(errorMessage, true);
    continue;
  }

  const videoHeightProcess = Deno.run({
    stdout: "piped",
    stdin: "null", // ignore this program's input
    stderr: "null", // ignore this program's input
    cmd: [
      "ffprobe",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=height",
      "-of",
      "csv=s=x:p=0",
      file.dir + file.base,
    ],
  });

  await videoHeightProcess.status();
  const heightResolution = Number(
    (new TextDecoder()).decode(await videoHeightProcess.output()),
  );

  const { options: resolutionOptions, matchedResolution } =
    findResolutionOptions(
      heightResolution,
    );

  await ensureDir(titleName); // make empty dist directory

  let conversionDurationInSeconds = 0;
  const conversionInterval = setInterval(() => {
    spinner.text = `[File ${prettyFileIndex} of ${filesToConvert.length}] [${
      prettyDuration(conversionDurationInSeconds)
    }] [${matchedResolution}p] Converting: ${titleName}...`;
    conversionDurationInSeconds++;
    totalConversionDurationInSeconds++;
  }, 1000);

  // create background image
  await Deno.run({
    cmd: [
      "ffmpegthumbnailer",

      // keep original size
      "-s",
      "0",

      "-i",
      file.dir + file.base,

      "-o",
      `${titleName}/background.jpg`,
    ],
  }).status();

  // additional options
  // ====================
  // "-fflags +genpts" - add this to regenerate packet timestamps
  //    (in case of error "Can't write packet with unknown timestamp")
  // "-loglevel error" - only show errors
  // "-b:v 3000k -bufsize 3000k" - set the video bitrate to 3Mbs:
  // "-ac 2" - sets 2 audio channels
  // "-an" - no audio

  const outputFileName = `${titleName}/${titleName}.webm`;
  const conversionProcess = Deno.run({
    stdout: "null", // ignore this program's output
    stdin: "null", // ignore this program's input
    stderr: "null", // ignore this program's input
    cmd: [
      "ffmpeg",
      "-i",
      file.dir + file.base,
      "-y", // overwrite output files

      "-sn", // no subtitles

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
  });

  await conversionProcess.status(); // wait for process to stop

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
  const integrityCheckProcess = Deno.run({
    stdout: "piped", // ignore this program's output
    stdin: "piped", // ignore this program's input
    stderr: "piped", // ignore this program's input
    cmd: [
      "ffmpeg",
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
  });

  await integrityCheckProcess.status();

  return (await integrityCheckProcess.stderrOutput())?.length > 0;
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
