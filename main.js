#!/usr/bin/env node
require("dotenv").config();

const args = require("yargs")
	.option("r", {
		alias: "resolution",
		description: "the input resolution of the video file/s",
		demandOption: true,
		choices: [360, 480, 720, 1080]
	})
	.option("i", {
		alias: "input",
		description: "glob pattern matching file/s",
		demandOption: true
	}).argv;

const glob = require("glob");
const chalk = require("chalk");
const ora = require("ora");
const ffmpeg = require("fluent-ffmpeg");
const { spawn } = require("child_process");
const { extname, resolve } = require("path");
const { DateTime, Duration } = require("luxon");
const { ensureDirSync, removeSync } = require("fs-extra");

glob(args.input, async (error, files) => {
	let spinner = ora(_prefixTime(`${files.length} will be converted`))
		.info()
		.start();

	for (let fileName of files) {
		const TITLE_NAME = fileName.replace(extname(fileName), "");

		ensureDirSync(TITLE_NAME); // make empty dist directory

		let conversionDurationInSeconds = 0;
		let conversionInterval = setInterval(() => {
			spinner.text = `[${(conversionDurationInSeconds / 60).toFixed(
				2
			)}m] Converting ${TITLE_NAME}...`;
			conversionDurationInSeconds++;
		}, 1000);

		// "-fflags +genpts" - add this to regenerate packet timestamps
		//    (in case of error "Can't write packet with unknown timestamp")
		// "-loglevel error" - only show errors
		// "-b:v 3000k -bufsize 3000k" - set the video bitrate to 3Mbs:
		// "-map 0" - copy all streams
		// "-ac 2" - sets 2 audio channels
		// "-an" - no audio
		// "-sn" - no subs

		let conversionProcess = ffmpeg(fileName).outputOptions([
			"-sn",
			"-map 0",
			"-ac 8",
			"-b:v 0",
			"-speed 4",
			"-frame-parallel 1",
			"-auto-alt-ref 1",
			"-lag-in-frames 25"
		]);

		//  configure resolution
		// ===============================================
		switch (args.resolution) {
			case 360:
				// 360p - CRF 36 / -tile-columns 1 / -threads 4
				conversionProcess = conversionProcess.outputOptions([
					"-crf 36",
					"-tile-columns 1",
					"-threads 4"
				]);
				break;
			case 480:
				// 480p - CRF 33 / -tile-columns 1 / -threads 4
				conversionProcess = conversionProcess.outputOptions([
					"-crf 33",
					"-tile-columns 1",
					"-threads 4"
				]);
				break;
			case 720:
				// 720p - CRF 32 / -tile-columns 2 / -threads 8
				conversionProcess = conversionProcess.outputOptions([
					"-crf 32",
					"-tile-columns 2",
					"-threads 8"
				]);
				break;
			case 1080:
				// 1080p - CRF 31 / -tile-columns 2 / -threads 8
				conversionProcess = conversionProcess.outputOptions([
					"-crf 31",
					"-tile-columns 2",
					"-threads 8"
				]);
				break;
		}
		// ===============================================

		try {
			await new Promise(resolve => {
				conversionProcess
					.on("end", resolve)
					.save(`${TITLE_NAME}/${TITLE_NAME}_unoptimized.webm`);
			});
		} catch (e) {
			console.error(e);
			process.exit(-1);
		}

		let cleanProcess = spawn(
			"mkclean",
			[
				"--quiet",
				"--optimize",
				`${TITLE_NAME}/${TITLE_NAME}_unoptimized.webm`,
				`${TITLE_NAME}/${TITLE_NAME}.webm`
			],
			{}
		);

		await _promisify(cleanProcess);

		// deletes the uncleaned/unoptimized webm file
		removeSync(`${TITLE_NAME}/${TITLE_NAME}_unoptimized.webm`);

		clearInterval(conversionInterval);

		let conversionDurationInHours = (
			conversionDurationInSeconds / 3600
		).toFixed(2);

		// done with this title
		let message = {
			message: `Done converting: ${TITLE_NAME} (Took ${conversionDurationInHours}h)`, // required
			title: "Webm Convert"
		};

		spinner
			.succeed(
				chalk.green.bgBlack(
					_prefixTime(`Done converting ${TITLE_NAME}`)
				)
			)
			.start();
	}

	// done with everything
	let message = {
		message: `Converted all ${files.length} files.`, // required
		title: "Webm Convert"
	};

	spinner.succeed(chalk.blue.bgBlack(_prefixTime("===== All Done =====")));
});

function _promisify(process) {
	return new Promise((resolve, reject) => {
		process.on("exit", data => {
			resolve(data);
		});

		process.on("error", error => {
			reject(error);
		});
	});
}

function _prefixTime(text) {
	return `[${_currentTime()}] ${text}`;
}

function _currentTime() {
	return DateTime.local().toLocaleString(DateTime.DATETIME_FULL_WITH_SECONDS);
}
