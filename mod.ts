#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

import { parse } from "https://deno.land/std@0.135.0/flags/mod.ts";
import { wait } from "https://deno.land/x/wait@0.1.12/mod.ts";
import {
  ensureDir,
  expandGlobSync,
} from "https://deno.land/std@0.135.0/fs/mod.ts";
import { extname } from "https://deno.land/std@0.135.0/path/mod.ts";
import Duration from "https://deno.land/x/durationjs@v2.3.2/mod.ts";
// load .env
import "https://deno.land/std@0.135.0/dotenv/load.ts";

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

const spinner = wait("Starting conversion in 5 seconds...").start();

// wait a bit
await new Promise((resolve) => setTimeout(resolve, 5000));

spinner.clear();
spinner.info(`${filesToConvert.length} files will be converted.`);

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

spinner.succeed("Finished conversion.");

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
    Deno.env.get("PUSHOVER_TOKEN") === undefined ||
    Deno.env.get("PUSHOVER_USER") === undefined
  ) {
    console.info(
      "PUSHOVER_TOKEN and PUSHOVER_USER environment variables not set.",
    );
    return;
  }

  const pushoverBody = new URLSearchParams();
  pushoverBody.append("token", Deno.env.get("PUSHOVER_TOKEN") || "");
  pushoverBody.append("user", Deno.env.get("PUSHOVER_USER") || "");
  pushoverBody.append("message", message);

  fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: pushoverBody,
  });
}
