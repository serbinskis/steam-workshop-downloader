import fs from 'fs';
import fse from 'fs-extra';
import child_process from 'child_process';
import got from 'got';
import request from 'request';
import AdmZip from 'adm-zip';
import archiver from 'archiver';

export interface CollectionChild {
    publishedfileid: string;
}

export interface CollectionDetail {
    children: CollectionChild[];
}

export interface SteamCollectionResponse {
    response: {
        collectiondetails: CollectionDetail[];
    };
}

export interface PublishedFileDetail {
    // Steam identifiers
    publishedfileid?: string;
    creator?: string;

    // Steam status
    result?: number; // 1 = OK, anything else = not found / private / banned
    banned?: number;
    ban_reason?: string;
    visibility?: number;

    // App info
    consumer_app_id?: number;
    creator_app_id?: number;

    // File info (used by your download / storage logic)
    file_url?: string;
    file_size?: number;
    filename?: string;
    time_created?: number;
    time_updated?: number;
    hcontent_file?: string;
    hcontent_preview?: string;
    preview_url?: string;

    // Local runtime fields mutated by downloader
    current?: number;
    total?: number;

    // Content info
    title?: string;
    description?: string;
    tags?: Array<{ [key: string]: any }>;

    // Stats
    subscriptions?: number;
    favorited?: number;
    lifetime_subscriptions?: number;
    lifetime_favorited?: number;
}

export interface SteamItemResponse {
    response: {
        publishedfiledetails: PublishedFileDetail[];
    };
}

export interface DownloadOptions {
    do_zip?: boolean;
    do_cleanup?: boolean;
    steam_dir?: string;
    consumer_app_id?: number;
    creator_app_id?: number;
}

export type CallbackStatus = 'steam' | 'error_unlisted' | 'error_not_downloadable' | 'start' | 'end';
export type CallbackFunction = (status: CallbackStatus, success?: boolean, item?: PublishedFileDetail) => void;


export class SteamUtils {
    static steamCmdUrl: string = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
    static steamWorkshopCollectionUrl: string = 'https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/';
    static steamWorkshopItemUrl: string = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

    /**
     * Spawns a new process from a command string.
     */
    private static async spawnSync(command: string, options?: child_process.SpawnOptions): Promise<void> {
        const args = command.split(/\s+/);
        if (!args[0]) { return Promise.resolve(); }

        return new Promise((resolve) => {
            child_process.spawn(args.shift(), args, options).on('close', resolve);
        });
    }

    /**
     * Asynchronously removes a file or directory.
     */
    private static async rmSync(path: fs.PathLike, options?: fs.RmOptions): Promise<void> {
        return new Promise((resolve) => fs.rm(path, options, () => resolve()));
    }

    /**
     * Asynchronously moves a file or directory.
     */
    private static async moveSync(source: string, destination: string, options?: fse.MoveOptions): Promise<void> {
        return new Promise((resolve) => fse.move(source, destination, options, () => resolve()));
    }

    /**
     * Zips a directory.
     */
    private static async zipDirectory(sourcePath: string, outputPath: string, level?: number, subdir?: boolean | string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (level === undefined) { level = 9; }
            if (subdir === undefined) { subdir = true; }
            const archive = archiver('zip', { zlib: { level: level }});
            const stream = fs.createWriteStream(outputPath);
            archive.directory(sourcePath, subdir).on('error', err => reject(err)).pipe(stream);
            stream.on('close', () => resolve());
            archive.finalize();
        });
    }

    /**
     * Fetches details for one or more Steam Workshop collections.
     * @param ids - A single collection ID or an array of collection IDs.
     * @returns A promise that resolves to an array of collection details, or null on error.
     */
    public static async getCollectionDetails(ids: string | string[]): Promise<CollectionDetail[] | null> {
        if (!Array.isArray(ids)) { ids = [String(ids)]; }

        return new Promise((resolve) => {
            var requestData = { format: 'json', collectioncount: ids.length, publishedfileids: ids };

            request.post(SteamUtils.steamWorkshopCollectionUrl, { form: requestData, json: true }, function (err: any, res: any, data: SteamCollectionResponse) {
                if (err) { return resolve(null); }
                if (!data || !data.response || !data.response.collectiondetails) { return resolve(null); }
                resolve(data.response.collectiondetails);
            });
        });
    }

    /**
     * Fetches details for one or more Steam Workshop items.
     * @param ids - A single item ID or an array of item IDs.
     * @returns A promise that resolves to an array of item details, or null on error.
     */
    public static async getItemDetails(ids: string | string[]): Promise<PublishedFileDetail[] | null> {
        if (!Array.isArray(ids)) { ids = [String(ids)]; }

        return new Promise((resolve) => {
            var requestData = { format: 'json', itemcount: ids.length, publishedfileids: ids };

            request.post(SteamUtils.steamWorkshopItemUrl, { form: requestData, json: true }, function (err: any, res: any, data: SteamItemResponse) {
                if (err) { return resolve(null); }
                if (!data || !data.response || !data.response.publishedfiledetails) { return resolve(null); }
                resolve(data.response.publishedfiledetails);
            });
        });
    }

    /**
     * Downloads and extracts SteamCMD to a specified path if it doesn't already exist.
     * @param path - The directory path where SteamCMD should be saved.
     */
    public static async downloadSteamCmd(path: string): Promise<void> {
        if (!fs.existsSync(`${path}/steamcmd.exe`)) {
            const steamcCmdZip = (await got(SteamUtils.steamCmdUrl)).rawBody;
            const zip = new AdmZip(steamcCmdZip);
            const steamCmdExe = zip.readFile(zip.getEntries()[0]);
            fs.mkdirSync(path, { recursive: true });
            fs.writeFileSync(`${path}/steamcmd.exe`, steamCmdExe);
        }
    }

    /**
     * Downloads all items from a list of Steam Workshop collections.
     * @param ids - A single collection ID or an array of collection IDs.
     * @param path - The destination path for the downloaded items.
     * @param opts - Download options.
     * @param callback - A function to call for progress and status updates.
     */
    public static async downloadCollections(ids: string | string[], path: string, opts: DownloadOptions, callback: CallbackFunction): Promise<void> {
        const details = await this.getCollectionDetails(ids);
        if (!details) { return; }
        const itemIds = details.flatMap(e => e.children.map(e => e.publishedfileid));
        if (itemIds.length === 0) { return; }
        await this.downloadItems(itemIds, path, opts, callback);
    }

    /**
     * Downloads a list of Steam Workshop items using SteamCMD.
     * @param ids - An array of item or one item IDs to download.
     * @param path - The destination path for the downloaded items.
     * @param opts - Download options.
     * @param callback - A function to call for progress and status updates.
     */
    public static async downloadItems(ids: string | string[], path: string, opts: DownloadOptions, callback?: CallbackFunction): Promise<void> {
        if (!opts) { opts = {}; }
        opts.do_zip = opts.do_zip || false;
        opts.do_cleanup = (opts.do_cleanup !== undefined) ? opts.do_cleanup : true;
        opts.steam_dir = opts.steam_dir || `${process.env.TEMP}/steamcmd`;
        if (!callback) { callback = () => {}; }

        if (!fs.existsSync(`${opts.steam_dir}/steamcmd.exe`)) {
            callback('steam');
            await this.downloadSteamCmd(opts.steam_dir);
            await SteamUtils.spawnSync(`${opts.steam_dir}/steamcmd.exe +quit`);
        } else {
            await SteamUtils.rmSync(`${opts.steam_dir}/steamapps/workshop`, { recursive: true, force: true });
        }

        const items = await this.getItemDetails(ids);
        if (!items) return;
        let counter = 0;

        if (!fs.existsSync(path)) {
            fs.mkdirSync(path, { recursive: true });
        }

        for (const item of items) {
            item.current = counter++ + 1;
            item.total = items.length;
            if (fs.existsSync(`${path}/${item.publishedfileid}`)) { continue; }
            if (!item.consumer_app_id && opts.consumer_app_id) { item.consumer_app_id = opts.consumer_app_id; }
            if (!item.creator_app_id && opts.creator_app_id) { item.creator_app_id = opts.creator_app_id; }
            if (!item.consumer_app_id) { callback('error_unlisted', false, item); continue; }
            if (item.consumer_app_id !== item.creator_app_id) { callback('error_not_downloadable', false, item); continue; }
            callback('start', true, item);

            const workshop = `+workshop_download_item ${item.consumer_app_id} ${item.publishedfileid}`;
            await SteamUtils.spawnSync(`${opts.steam_dir}/steamcmd.exe +login anonymous ${workshop} +quit`);

            const arg0 = `${opts.steam_dir}/steamapps/workshop/content/${item.consumer_app_id}/${item.publishedfileid}`;
            const arg1 = fs.existsSync(arg0);

            if (opts.do_zip) {
                if (arg1) { await SteamUtils.zipDirectory(arg0, `${path}/${item.publishedfileid}.zip`, 9, `${item.publishedfileid}`); }
            } else {
                if (arg1) { await SteamUtils.moveSync(arg0, `${path}/${item.publishedfileid}`, { overwrite: true }); }
            }

            await SteamUtils.rmSync(`${opts.steam_dir}/steamapps/workshop`, { recursive: true, force: true });
            callback('end', arg1, item);
        }

        if (opts.do_cleanup) { await SteamUtils.rmSync(opts.steam_dir, { recursive: true, force: true }); }
    }
}