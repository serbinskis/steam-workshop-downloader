export const config = {
    HTTP_PORT: 84,
    HTTPS_PORT: 8447,
    MAX_FILE_SIZE: 1000 * 1024 * 1024,
    STEAM_DIR: './steamcmd',
    CERTIFICATE_DIR: './../-(CERTIFICATE)-',
    STEAM_ID_REGEX: new RegExp(/^\d+$/gm),
    BUSY: false,

    DATABASE_TABLES: {
        'items': [
            { name: 'id', type: 'TEXT', pkey: true },
            { name: 'steamd_id', type: 'TEXT', },
            { name: 'download_url', type: 'TEXT', },
            { name: 'size', type: 'INTEGER' },
        ]
    } as const,
}