import { Readable } from "stream";
import { request } from "undici";

export class Transporter {
    private static UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";

    /**
     * Uploads a zip archive with optional progress reporting.
     * @param fileStream The Readable stream of the file to upload.
     * @param filename Name of the file being uploaded.
     * @param onProgress Optional callback called with uploaded bytes.
     */
    static async uploadZipArchive(fileStream: Readable, filename: string, onProgress?: (uploadedBytes: number) => void): Promise<string | null> {
        const boundary = `----SteamWorkshopBoundaryBoundary${Date.now()}`; // Generate boundary as per your Java example's pattern
        const encoder = new TextEncoder(); // Used to convert strings to Uint8Array/Buffer

        // Define static parts of the multipart/form-data body as Buffers
        // These are small and will be buffered in memory.

        const reqtypePartHeader = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\n`);
        const reqtypePartValue = encoder.encode(`fileupload\r\n`);
        const timePartHeader = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="time"\r\n\r\n`);
        const timePartValue = encoder.encode(`72h\r\n`);
        const filePartHeader = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const filePartFooter = encoder.encode(`\r\n`);
        const finalBoundary = encoder.encode(`--${boundary}--\r\n`);

        // Create an async generator function that will yield parts of the request body
        // This is where the streaming magic happens, explicitly yielding chunks.
        async function* createMultipartBodyGenerator(): AsyncIterable<Buffer> { // Generator now yields only Buffer
            yield Buffer.from(reqtypePartHeader); // Yield static field parts
            yield Buffer.from(reqtypePartValue);
            yield Buffer.from(timePartHeader);
            yield Buffer.from(timePartValue);
            yield Buffer.from(filePartHeader); // Yield the file part header
            let uploadedBytes = 0;

            for await (const chunk of fileStream) {
                uploadedBytes += chunk.length;
                if (onProgress) onProgress(uploadedBytes); // Report progress
                yield Buffer.from(chunk);
            }

            yield Buffer.from(filePartFooter); // Yield the file part footer and the final boundary
            yield Buffer.from(finalBoundary);
        }

        try {
            const response = await request(Transporter.UPLOAD_URL, {
                method: "POST",
                headers: { "User-Agent": "Mozilla/5.0",  "Content-Type": `multipart/form-data; boundary=${boundary}` },
                body: Readable.from(createMultipartBodyGenerator()), // undici will consume this combined stream of Buffers
            });

            if (response.statusCode !== 200) {
                const errorBody = await response.body.text(); // This consumes the stream
                console.log(`[Transporter] uploadZipArchive -> Error response: ${errorBody.slice(0, 200)}`); // Log first 200 chars of error body
                fileStream.destroy(new Error(`[Transporter] uploadZipArchive -> Server responded with status ${response.statusCode}`));
                return null;
            }

            const body = await response.body.text();
            return body.trim() || null;
        } catch (error) {
            fileStream.destroy(error as Error); // Destroy the input stream on any request error
            return null;
        }
    }

    /**
     * Downloads a file from a URL and returns a Readable stream.
     * Can be piped directly to a file or other streams.
     * @param url The URL to download from.
     * @returns Readable stream of the file content.
     */
    static async downloadFileAsStream(url: string): Promise<Readable> {
        try {
            const response = await request(url, { method: "GET" });

            if (response.statusCode !== 200) {
                throw new Error(`Failed to download file, status code: ${response.statusCode}`);
            }

            // Convert the undici body (ReadableStream) into Node.js Readable
            return Readable.from(response.body as AsyncIterable<Uint8Array>);
        } catch (err) {
            console.log(`[Transporter] downloadFileAsStream error:`, (err as Error).message);
            throw err; // let the caller handle errors
        }
    }

    /**
     * Checks if a file exists at the given URL using a HEAD request.
     * @param url The URL to check.
     * @returns true if the file exists (status 200), false otherwise.
     */
    static async fileExists(url: string): Promise<boolean> {
        try {
            const response = await request(url, { method: "HEAD" });
            return (response.statusCode === 200);
        } catch (err) {
            console.log(`[Transporter] fileExists error:`, (err as Error).message);
            return false;
        }
    }
}