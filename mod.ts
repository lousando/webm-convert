#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

import { parse } from "https://deno.land/std@0.135.0/flags/mod.ts";
import { wait } from "https://deno.land/x/wait@0.1.12/mod.ts";
import {
  ensureDir,
  expandGlobSync,
} from "https://deno.land/std@0.135.0/fs/mod.ts";
import { extname } from "https://deno.land/std@0.135.0/path/mod.ts";
import Duration from "https://deno.land/x/durationjs@v2.3.2/mod.ts";
import { Database } from "https://deno.land/x/aloedb@0.9.0/mod.ts";

const configFile = `${Deno.env.get("HOME")}/.webm-convert.json`;

interface AppConfig {
  version: number;
  pushover_token: string;
  pushover_user: string;
}

const configDB = new Database<AppConfig>({
  path: configFile,
  pretty: true,
  optimize: false, // does not batch saves and allows for #save to wait on disk write
});

const currentConfigFileVersion = 1;

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
    pushover_user: "",
  });
  await configDB.save(); // make sure this is written to disk before continuing
  console.log(
    `Config saved to ${configFile}. Restart program for changes to take effect.\n`,
  );
}

// todo: check if ffmpeg is installed

const args = parse(Deno.args, {
  alias: {
    "r": "resolution",
    "i": "input",
  },
  string: [
    "resolution",
    "input",
  ],
});

function showHelpAndExit() {
  console.log(`Options:
      -r, --resolution  the input resolution of the video file/s
                                           [required] [choices: 360, 480, 720, 1080]
      -i, --input       glob pattern matching file/s                      [required]
    `);
  Deno.exit(-1);
}

if (!args.input || !args.resolution) {
  showHelpAndExit();
}

const resolutionChoices = [
  "360",
  "480",
  "720",
  "1080",
];

if (!resolutionChoices.includes(args.resolution)) {
  showHelpAndExit();
}

const filesToConvert = [];

for (const file of expandGlobSync(args.input)) {
  if (file.isFile) {
    filesToConvert.push(file);
  }
}

if (filesToConvert.length === 0) {
  console.log(`No files found matching ${args.input}`);
  Deno.exit(-1);
}

const spinner = wait("Conversion starting in 5 seconds...").start();

Deno.addSignalListener("SIGINT", () => {
  spinner.clear(); // prevent weird console cursor on exit
  spinner.info("Conversion interrupted.");
  Deno.exit(-1);
});

// wait a bit
await new Promise((resolve) => setTimeout(resolve, 5000));

spinner.clear();
spinner.info(`${filesToConvert.length} files will be converted.`);

let totalConversionDurationInSeconds = 0;

for (const file of filesToConvert) {
  spinner.start();
  const titleName = file.name.replace(extname(file.name), "");

  await ensureDir(titleName); // make empty dist directory

  let conversionDurationInSeconds = 0;
  const conversionInterval = setInterval(() => {
    spinner.text = `[${
      prettyDuration(conversionDurationInSeconds)
    }] Converting: ${titleName}...`;
    conversionDurationInSeconds++;
    totalConversionDurationInSeconds++;
  }, 1000);

  let resolutionOptions: Array<string> = [];

  //  configure resolution
  // ===============================================
  switch (args.resolution) {
    case 360:
      // 360p - CRF 36 / -tile-columns 1 / -threads 4
      resolutionOptions = [
        "-crf",
        "36",
        "-tile-columns",
        "1",
        "-threads",
        "4",
      ];
      break;
    case 480:
      // 480p - CRF 33 / -tile-columns 1 / -threads 4
      resolutionOptions = [
        "-crf",
        "33",
        "-tile-columns",
        "1",
        "-threads",
        "4",
      ];
      break;
    case 720:
      // 720p - CRF 32 / -tile-columns 2 / -threads 8
      resolutionOptions = [
        "-crf",
        "32",
        "-tile-columns",
        "2",
        "-threads",
        "8",
      ];
      break;
    case 1080:
      // 1080p - CRF 31 / -tile-columns 2 / -threads 8
      resolutionOptions = [
        "-crf",
        "31",
        "-tile-columns",
        "2",
        "-threads",
        "8",
      ];
      break;
  }
  // ===============================================

  // additional options
  // ====================
  // "-fflags +genpts" - add this to regenerate packet timestamps
  //    (in case of error "Can't write packet with unknown timestamp")
  // "-loglevel error" - only show errors
  // "-b:v 3000k -bufsize 3000k" - set the video bitrate to 3Mbs:
  // "-ac 2" - sets 2 audio channels
  // "-an" - no audio

  const conversionProcess = Deno.run({
    stdout: "null", // ignore this program's output
    stdin: "null", // ignore this program's input
    stderr: "null", // ignore this program's input
    cmd: [
      "ffmpeg",
      "-i",
      file.path,
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
      `${titleName}/${titleName}.webm`,
    ],
  });

  await conversionProcess.status(); // wait for process to stop

  spinner.stop(); // stop before clearing interval so spinner doesn't get stuck
  clearInterval(conversionInterval);

  const successMessage = `Done converting: ${titleName} (Took ${
    prettyDuration(conversionDurationInSeconds)
  })`;

  spinner.succeed(successMessage);
  sendPushoverMessage(successMessage);
}

const doneMessage = `Finished converting ${filesToConvert.length} files (Took ${
  prettyDuration(totalConversionDurationInSeconds)
}).`;

spinner.succeed(doneMessage);
sendPushoverMessage(doneMessage);

// utility functions
// ===================

function prettyDuration(durationInSeconds = 0) {
  return new Duration(durationInSeconds * 1000).stringify(
    ["h", "s", "m"],
    true,
  );
}

function sendPushoverMessage(message = "") {
  if (
    !config?.pushover_token ||
    !config?.pushover_token
  ) {
    console.info(
      `"pushover_token" or "pushover_user" is not set in ${configFile}`,
    );
    return;
  }

  const pushoverBody = new URLSearchParams();
  pushoverBody.append("token", config?.pushover_token);
  pushoverBody.append("user", config?.pushover_user);
  pushoverBody.append("message", message);

  fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: pushoverBody,
  });
}
