import fs from 'fs';
import http, { Server } from 'http';
import https from 'https';
import express from 'express';
import sutils from 'serbinskis-utils';
import Database from './helpers/database.js';
import { config } from './config.js';
import { scheduleJob } from 'node-schedule';
import { PublishedFileDetail, SteamUtils } from './helpers/steam.js';
import { Transporter } from './helpers/transporter.js';

const app = express();
app.use(express.static('website', { index: false }));

process.title = 'Steam Workshop Downloader';
process.on('message', (message: any) => { if (message.command == 'SIGINT') { process.emit('SIGINT'); } });
process.on('SIGINT', () => { process.exit(); });
(console as any)._log = console.log;

console.log = (...args: any[]) => {
    (console as any)._log(`[${sutils.getTimeString()}]`, ...args);
}

const db = new Database({
    filename: '../database/database.db',
    error_callback: (name, err) => { console.error(name, err.message); process.exit(1); },
    delete_unused: true,
    reorder: true,
    tables: config.DATABASE_TABLES,
    backup_interval: 60 * 60 * 1000,
    backup_enabled: true,
});

(async () => {
    while (!await sutils.isOnline()) { await sutils.Wait(1000); }
    await db.open();
    console.log(`Opened database: "${db.filename}".`);
    scheduleJob({ hour: 6, minute: 0, dayOfWeek: 1 }, async () => process.exit());

    var httpsOptions = {
        cert: await new Promise((resolve) => fs.readFile(`${config.CERTIFICATE_DIR}/certificate.crt`, (err, data) => resolve(data))) as Buffer,
        ca: await new Promise((resolve) => fs.readFile(`${config.CERTIFICATE_DIR}/ca_bundle.crt`, (err, data) => resolve(data))) as Buffer,
        key: await new Promise((resolve) => fs.readFile(`${config.CERTIFICATE_DIR}/private.key`, (err, data) => resolve(data))) as Buffer,
    }

    if (Object.values(httpsOptions).some(e => !e)) { console.log('[HTTPS WARNING] A certificate was not provided.'); }
    try { fs.rmSync('workshop', { recursive: true, force: true }); } catch (err) { }
    let setup = (server: Server) => { server.timeout = server.keepAliveTimeout = server.headersTimeout = server.requestTimeout = 0; return server; }

    setup(http.createServer(app)).listen(config.HTTP_PORT, (process.env.DEBUG ? sutils.IPV4Address() : null), () => {
        console.log(`Listening on ${sutils.IPV4Address()}:${config.HTTP_PORT} (HTTP)`);
    });

    setup(https.createServer(httpsOptions, app)).listen(config.HTTPS_PORT, (process.env.DEBUG ? sutils.IPV4Address() : null), () => {
        console.log(`Listening on ${sutils.IPV4Address()}:${config.HTTPS_PORT} (HTTPS)`);
    });
})();

app.get('/', async (req, res) => {
    res.sendFile(`${__dirname}/website/index.html`);
});

app.get('/info/*', async (req, res) => {
    var steamId = req.url.split('/')[2] || '';
    if ((steamId != '') && !steamId.match(config.STEAM_ID_REGEX)) { return sendResponse(res, 400, { code: 400, message: 'Bad request: Invalid ID.' }); }

    var result = await SteamUtils.getItemDetails(steamId);
    if (!result) { return sendResponse(res, 404, { code: 404, message: 'Item not found.' }); }
    sendResponse(res, 200, { code: 200, message: 'The operation completed successfully.', data: result });
});

app.get('/prepare/*', async (req, res) => {
    try { var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(':').pop(); } catch(e) { ip = ''; }
    let steamId = req.url.split('/')[2] || '';
    if ((steamId != '') && !steamId.match(config.STEAM_ID_REGEX)) { return sendResponse(res, 400, { code: 400, message: 'Bad request: Invalid ID.' }); }
    if (config.BUSY) { return sendResponse(res, 503 , { code: 503 , message: 'Service Unavailable: Server is busy.' }); }
    console.log(`[${ip}] (PREPARE) Requested workshop item with id: "${steamId}"`); //Just some simple console logging

    //Get items details and download and upload to storage
    let workshopItem: PublishedFileDetail = (await SteamUtils.getItemDetails(steamId))[0]
    if (workshopItem?.result != 1) { return sendResponse(res, 404, { code: 404, message: 'Item not found.' }); }
    if (!workshopItem?.file_url && !(await prepareItem(ip, steamId, workshopItem, false))) { return sendResponse(res, 500, { code: 500, message: 'Internal server error.' }); }

    //Check if file exists in storage if no, then redownload
    let dbItem = await db.models.items.find(`${steamId}_${workshopItem.time_updated}`);
    let fileExists = workshopItem?.file_url ? true : await Transporter.fileExists(dbItem.download_url);
    if (!fileExists) { fileExists = await prepareItem(ip, steamId, workshopItem, true); }
    if (!fileExists) { return sendResponse(res, 500, { code: 500, message: 'Internal server error.' }); }

    //Send file from storage to client
    console.log(`[${ip}] Sending workshop status for id: "${steamId}".`);
    sendResponse(res, 200, { code: 200, message: 'The operation completed successfully.', data: { status: true } });
});

app.get('/download/*', async (req, res) => {
    try { var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(':').pop(); } catch(e) { ip = ''; }
    let steamId = req.url.split('/')[2] || '';
    if ((steamId != '') && !steamId.match(config.STEAM_ID_REGEX)) { return sendResponse(res, 400, { code: 400, message: 'Bad request: Invalid ID.' }); }
    if (config.BUSY) { return sendResponse(res, 503 , { code: 503 , message: 'Service Unavailable: Server is busy.' }); }
    console.log(`[${ip}] (DOWNLOAD) Requested workshop item with id: "${steamId}"`); //Just some simple console logging

    //Get items details and download and upload to storage
    let workshopItem: PublishedFileDetail = (await SteamUtils.getItemDetails(steamId))[0];
    if (workshopItem?.result != 1) { return sendResponse(res, 404, { code: 404, message: 'Item not found.' }); }

    // Check if direct file exists if no, then try to download workshop item
    let fileUrlExists = Boolean(workshopItem?.file_url);
    if (!fileUrlExists) { fileUrlExists = await prepareItem(ip, steamId, workshopItem, false); }
    if (!fileUrlExists) { return sendResponse(res, 500, { code: 500, message: 'Internal server error.' }); }

    // Check if file exists in storage if no, then redownload
    let dbItem = await db.models.items.find(`${steamId}_${workshopItem.time_updated}`);
    let fileExists = workshopItem?.file_url ? true : await Transporter.fileExists(dbItem.download_url);
    if (!fileExists) { fileExists = await prepareItem(ip, steamId, workshopItem, true); }
    if (!fileExists) { return sendResponse(res, 500, { code: 500, message: 'Internal server error.' }); }

    // Send file from storage to client
    console.log(`[${ip}] Sending workshop item with id: "${steamId}" to client.`);
    if (!workshopItem?.file_url) { res.setHeader('Content-Type', 'application/zip'); }
    res.setHeader('Content-Disposition', `attachment; filename=${workshopItem?.file_url ? encodeURI(workshopItem.filename) : `workshop_${steamId}.zip`}`);
    res.setHeader('Content-Length', workshopItem?.file_url ? workshopItem.file_size : dbItem.size);
    res.writeHead(200);

    let stream = await Transporter.downloadFileAsStream(workshopItem?.file_url ? workshopItem?.file_url : dbItem.download_url);
    if (!stream) { return sendResponse(res, 500, { code: 500, message: 'Internal server error.' }); }
    stream.pipe(res);
});

function sendResponse(response, code, data): void {
    response.setHeader('Content-Type', 'application/json');
    response.writeHead(code);
    response.write(JSON.stringify(data));
    response.end();
}

async function prepareItem(ip: string, steamId: string, workshopItem: PublishedFileDetail, force: boolean) {
    try {
        config.BUSY = true;
        var fid = `${steamId}_${workshopItem.time_updated}`;
        if (force) { await db.models.items.delete(fid); }
        if (await db.models.items.find(fid)) { return !(config.BUSY = false); }

        console.log(`[${ip}] Downloading workshop item with id: "${steamId}" from steam.`);
        await SteamUtils.downloadItems(steamId, 'workshop', { do_cleanup: false, do_zip: true, steam_dir: config.STEAM_DIR });
        if (!fs.existsSync(`workshop/${steamId}.zip`)) { throw Error('No zip file found when uploading.'); }

        let fileSize = fs.statSync(`workshop/${steamId}.zip`).size;
        let formatedSize = sutils.formatBytes(fs.statSync(`workshop/${steamId}.zip`).size, 2);
        if (fs.statSync(`workshop/${steamId}.zip`).size >= config.MAX_FILE_SIZE) { throw Error('Workshop item too big for upload.'); }

        let lastLogged = 0;
        let fileStream = fs.createReadStream(`workshop/${steamId}.zip`);
        let url = await Transporter.uploadZipArchive(fileStream, "myfile.zip", (uploaded) => {
            if (Date.now() - lastLogged < 2000) { return; } // Only log every 2s
            console.log(`[${ip}] Uploading workshop item with id: "${steamId}" to storage with size: ${sutils.formatBytes(uploaded)}/${formatedSize}.`);
            lastLogged = Date.now();
        });

        fs.unlinkSync(`workshop/${steamId}.zip`);
        if (!url) { config.BUSY = false; return false; }
        await await db.models.items.create(fid, steamId, url, fileSize).save();
        return !(config.BUSY = false);
    } catch (err) {
        console.log(err.message);
        try { fs.unlinkSync(`workshop/${steamId}.zip`); } catch (err) { }
        return (config.BUSY = false);
    }
}