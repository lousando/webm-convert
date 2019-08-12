let { app, BrowserWindow, ipcMain } = require("electron");

app.on("ready", () => {

	let window = new BrowserWindow({
		width: 500,
		height: 500,
		resizable: false,
		webPreferences: {
			nodeIntegration: true
		}
	});

	window.loadFile("www/index.html");
});


