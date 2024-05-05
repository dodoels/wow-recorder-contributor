import fs from 'fs';
import { EventEmitter } from 'stream';
import axios, { AxiosRequestConfig } from 'axios';
import {
  CloudMetadata,
  CloudSignedMetadata,
  CompleteMultiPartUploadRequestBody,
  CreateMultiPartUploadResponseBody,
} from 'main/types';
import path from 'path';

const devMode =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

/**
 * A client for retrieving resources from the cloud.
 */
export default class CloudClient extends EventEmitter {
  /**
   * The bucket name we're configured to target. Expected to be the name of
   * the guild as configured in the settings.
   */
  private bucket: string;

  /**
   * The last modified time of the bucket as per the mtime object. This is
   * to avoid needing to do multiple list operations on the bucket to determine
   * if anything has changed, a get on a single object is much cheaper.
   */
  private bucketLastMod = '0';

  /**
   * The auth header for the WR API, which uses basic HTTP auth using the cloud
   * user and password.
   */
  private authHeader: string;

  /**
   * Timer for checking the cloud store for updates.
   */
  private pollTimer: NodeJS.Timer | undefined;

  /**
   * The WR API endpoint. This is used for authentication, retrieval and
   * manipulation of video state from the video database, and various
   * bits of R2 interaction.
   */
  private apiEndpoint = devMode
    ? 'https://warcraft-recorder-dev.alex-kershaw4.workers.dev'
    : 'https://warcraft-recorder-api-v2.alex-kershaw4.workers.dev';

  /**
   * Constructor.
   */
  constructor(user: string, pass: string, bucket: string) {
    super();
    console.info('[CloudClient] Creating cloud client with', user, bucket);
    this.bucket = bucket;
    this.authHeader = CloudClient.createAuthHeader(user, pass);
  }

  /**
   * Build the Authorization header string.
   */
  private static createAuthHeader(user: string, pass: string) {
    const authHeaderString = `${user}:${pass}`;
    const encodedAuthString = Buffer.from(authHeaderString).toString('base64');
    return `Basic ${encodedAuthString}`;
  }

  /**
   * Get the video state from the WR database.
   */
  public async getState(): Promise<CloudSignedMetadata[]> {
    console.info('[CloudClient] Getting video state');
    const encGuild = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encGuild}/videos`;
    const headers = { Authorization: this.authHeader };
    const response = await axios.get(url, { headers });
    return response.data;
  }

  /**
   * Add a video to the WR database.
   */
  public async postVideo(metadata: CloudMetadata) {
    console.info('[CloudClient] Adding video to database', metadata.videoName);
    const encGuild = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encGuild}/videos`;
    const headers = { Authorization: this.authHeader };

    const response = await axios.post(url, metadata, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status !== 200) {
      console.error(
        '[CloudClient] Failed to add a video to database',
        status,
        data
      );

      throw new Error('Failed to add a video to database');
    }
  }

  /**
   * Delete a video.
   */
  public async deleteVideo(videoName: string) {
    console.info('[CloudClient] Deleting video', videoName);
    const encGuild = encodeURIComponent(this.bucket);
    const encName = encodeURIComponent(videoName);
    const url = `${this.apiEndpoint}/${encGuild}/videos/${encName}`;
    const headers = { Authorization: this.authHeader };

    const response = await axios.delete(url, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status !== 200) {
      console.error(
        '[CloudClient] Failed to delete a video from database',
        status,
        data
      );

      throw new Error('Failed to delete a video from database');
    }
  }

  /**
   * Protect a video.
   */
  public async protectVideo(videoName: string, bool: boolean) {
    console.info('[CloudClient] Set protected', bool, videoName);
    const encGuild = encodeURIComponent(this.bucket);
    const encName = encodeURIComponent(videoName);
    const url = `${this.apiEndpoint}/${encGuild}/videos/${encName}/protected`;
    const headers = { Authorization: this.authHeader };
    const body = bool ? 'true' : 'false';

    const response = await axios.post(url, body, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status !== 200) {
      console.error('[CloudClient] Failed to protect a video', status, data);
      throw new Error('Failed to protect a video');
    }
  }

  /**
   * Tag a video.
   */
  public async tagVideo(videoName: string, tag: string) {
    console.info('[CloudClient] Set tag', tag, videoName);
    const encGuild = encodeURIComponent(this.bucket);
    const encName = encodeURIComponent(videoName);
    const url = `${this.apiEndpoint}/${encGuild}/videos/${encName}/tag`;
    const headers = { Authorization: this.authHeader };

    const response = await axios.post(url, tag, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status !== 200) {
      console.error('[CloudClient] Failed to tag a video', status, data);
      throw new Error('Failed to tag a video');
    }
  }

  /**
   * Get an object and write it to a file.
   */
  public async getAsFile(
    key: string,
    url: string,
    dir: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    progressCallback = (_progress: number) => {}
  ) {
    console.info('[CloudClient] Downloading file from cloud store', key);

    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const enckey = encodeURIComponent(key);

    const sizeUrl = `${this.apiEndpoint}/${encbucket}/size/${enckey}`;
    const sizeRsp = await axios.get(sizeUrl, { headers });
    const sizeData = sizeRsp.data;
    const { size } = sizeData;

    console.info('[CloudClient] Bytes to download', size, 'for key', key);

    const config: AxiosRequestConfig = {
      responseType: 'stream',
      onDownloadProgress: (event) =>
        progressCallback(Math.round((100 * event.loaded) / size)),
    };

    const response = await axios.get(url, config);
    const file = path.join(dir, key);
    const writer = fs.createWriteStream(file);

    const finished = new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    response.data.pipe(writer);
    await finished;
  }

  /**
   * Sign a PUT URL by requesting the WR API signs it. This is our protection
   * against malicious uploads; the content length is included in the header
   * and the WR API checks the current bucket usage before approving.
   */
  private async signPutUrl(key: string, length: number) {
    console.info('[CloudClient] Getting signed PUT URL', key, length);

    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const enckey = encodeURIComponent(key);
    const url = `${this.apiEndpoint}/${encbucket}/upload/${enckey}/${length}`;

    const response = await axios.get(url, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status !== 200) {
      console.error(
        '[CloudClient] Failed to get signed upload request',
        response.status,
        response.data
      );

      throw new Error('Failed to get signed upload request');
    }

    return data.signed;
  }

  /**
   * Create a multi part upload by calling the WR API to get a list of signed
   * URLs for each part. Once we've uploaded to each URL in turn, must call
   * completeMultiPartUpload.
   */
  private async createMultiPartUpload(
    key: string,
    length: number
  ): Promise<CreateMultiPartUploadResponseBody> {
    console.info('[CloudClient] Create signed multipart upload', key, length);

    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const enckey = encodeURIComponent(key);
    const url = `${this.apiEndpoint}/${encbucket}/create-multipart-upload/${enckey}/${length}`;

    const response = await axios.get(url, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status !== 200) {
      console.error(
        '[CloudClient] Failed to get signed multipart upload request',
        status,
        data
      );

      throw new Error('Failed to get signed multipart upload request');
    }

    return data;
  }

  /**
   * Complete a multipart upload by calling the WR API.
   */
  private async completeMultiPartUpload(key: string, etags: string[]) {
    console.info('[CloudClient] Complete signed multipart upload', key);

    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const enckey = encodeURIComponent(key);
    const url = `${this.apiEndpoint}/${encbucket}/complete-multipart-upload/${enckey}`;

    const body: CompleteMultiPartUploadRequestBody = {
      etags,
    };

    const rsp = await axios.post(url, body, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = rsp;

    if (status !== 200) {
      console.error(
        '[CloudClient] Failed to complete multipart upload',
        status,
        data
      );

      throw new Error('Failed to complete multipart upload');
    }
  }

  /**
   * Write a JSON string into R2.
   */
  public async putJsonString(str: string, key: string) {
    console.info('[CloudClient] PUT JSON string with key', key);

    // Must convert to UTF-8 to avoid encoding shenanigans here with
    // handling special characters.
    const buffer = Buffer.from(str, 'utf-8');
    const signedUrl = await this.signPutUrl(key, buffer.length);

    const rsp = await axios.put(signedUrl, buffer, {
      headers: {
        'Content-Length': buffer.length,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    const { status, data } = rsp;

    if (status >= 400) {
      console.error('[CloudClient] JSON upload failed', key, status, data);
      throw new Error('Uploading a JSON string to the cloud failed');
    }

    await this.updateLastMod();
  }

  /**
   * Write a file into R2.
   */
  public async putFile(
    file: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    progressCallback = (_progress: number) => {}
  ) {
    const key = path.basename(file);
    console.info('[CloudClient] Uploading', file, 'to', key);
    const stats = await fs.promises.stat(file);

    // If a file is larger than 4.995GB, we need to use a multipart approach,
    // else it will be rejected by R2. See https://github.com/aza547/wow-recorder/issues/489
    // and https://developers.cloudflare.com/r2/reference/limits.
    const sizeThresholdBytes = 4.9 * 1024 ** 3;

    if (stats.size < sizeThresholdBytes) {
      await this.doSinglePartUpload(file, progressCallback);
    } else {
      await this.doMultiPartUpload(file, progressCallback);
    }

    await this.updateLastMod();
  }

  /**
   * Delete an object via the WR API.
   */
  public async delete(key: string) {
    console.info('[Cloud Client] Deleting', key);
    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const enckey = encodeURIComponent(key);
    const url = `${this.apiEndpoint}/${encbucket}/${enckey}`;
    await axios.delete(url, { headers });
    console.info('[Cloud Client] Deleted', key);
    await this.updateLastMod();
  }

  /**
   * Initialize the bucketLastMod time by reading it from the mtime object in
   * R2. If the mtime object doesn't exist, we will create it.
   */
  public async pollInit() {
    console.info('[CloudClient] Poll init');

    try {
      const mtime = await this.getMtime();
      this.bucketLastMod = mtime;
    } catch (error) {
      if (String(error).includes('NoSuchKey')) {
        console.info('[CloudClient] Hit NoSuchKey, mtime will be created');
        await this.updateLastMod();
      } else {
        console.error('[CloudClient] Error getting mtime', String(error));
        throw new Error('Error getting mtime from R2');
      }
    }
  }

  /**
   * Set a timer to poll for updates.
   */
  public pollForUpdates(sec: number) {
    console.info('[CloudClient] Start polling for updates');
    this.stopPollForUpdates();

    this.pollTimer = setInterval(() => {
      this.checkForUpdate();
    }, sec * 1000);
  }

  /**
   * Clear the polling timer.
   */
  public stopPollForUpdates() {
    console.info('[CloudClient] Stop polling for updates');

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }

  /**
   * Get the total R2 space in use by the guild.
   */
  public async getUsage() {
    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encbucket}/usage`;
    const response = await axios.get(url, { headers });
    const { data } = response;
    const { usage } = data;
    return parseInt(usage, 10);
  }

  /**
   * Get guild max storage.
   */
  public async getMaxStorage() {
    console.info('[CloudClient] Get max storage from API');
    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encbucket}/storage`;

    const response = await axios.get(url, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status === 401) {
      console.error('[CloudClient] 401 response from worker', data);
      throw new Error('Login to cloud store failed, check your credentials');
    }

    if (status !== 200) {
      console.error('[CloudClient] Failure response from worker', status, data);
      throw new Error('Error logging into cloud store');
    }

    console.info('[CloudClient] Max storage was', data.maxGB);
    return data.maxGB;
  }

  /**
   * Call the API to run housekeeping, typically called after a video
   * upload, but theorically safe to call whenever. Logs the result.
   */
  public async runHousekeeping() {
    console.info('[CloudClient] Run housekeeper');

    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encbucket}/housekeeping`;

    const response = await axios.post(url, undefined, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status === 401) {
      console.error('[CloudClient] 401 response from worker', data);
      throw new Error('Login to cloud store failed, check your credentials');
    }

    if (status !== 200) {
      console.error('[CloudClient] Failure response from worker', status, data);
      throw new Error('Error logging into cloud store');
    }

    console.info('[CloudClient] Housekeeping results:', data);
  }

  /**
   * Checks we're authenticated and authorized to access the cloud resources.
   */
  public async auth() {
    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encbucket}/auth`;

    const response = await axios.get(url, {
      headers,
      validateStatus: () => true,
    });

    const { status, data } = response;

    if (status === 401 || status === 403) {
      console.error('[CloudClient] Auth failed:', status, data);
      throw new Error('Login to cloud store failed, check your credentials');
    }

    if (status !== 200) {
      console.error('[CloudClient] Failure response from worker', status, data);
      throw new Error('Error logging into cloud store');
    }

    console.info('[CloudClient] Auth success!');
  }

  /**
   * Get the mtime object from R2, this keeps track of the most recent
   * modification time to any R2 data.
   */
  private async getMtime(): Promise<string> {
    const headers = { Authorization: this.authHeader };
    const encbucket = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encbucket}/mtime`;
    const response = await axios.get(url, { headers });
    const { data } = response;
    return data.toString();
  }

  /**
   * Check if the mtime object in R2 matches what we think it is, if it doesn't
   * we need to trigger a UI refresh.
   */
  private async checkForUpdate() {
    const mtime = await this.getMtime();

    if (mtime !== this.bucketLastMod) {
      console.info(
        '[CloudClient] Cloud data changed:',
        mtime,
        this.bucketLastMod
      );

      this.emit('change');
      this.bucketLastMod = mtime;
    }
  }

  /**
   * Update the mtime object in R2 to reflect the most recent mod time, typically
   * should call this whenever you update an object to trigger other clients to
   * refresh.
   */
  private async updateLastMod() {
    const mtime = new Date().getTime().toString();
    console.info('[CloudClient] Updating last mod time to', mtime);
    this.bucketLastMod = mtime;
    const encbucket = encodeURIComponent(this.bucket);
    const url = `${this.apiEndpoint}/${encbucket}/mtime/${mtime}`;
    const headers = { Authorization: this.authHeader };
    await axios.post(url, undefined, { headers });
  }

  /**
   * Get the content type based on the key name. It's good to pass the to
   * R2 as if we set a video content type, a link to it will be played by
   * browsers, rather than just downloading the file.
   */
  private static getContentType(key: string) {
    if (key.endsWith('.mp4')) {
      return 'video/mp4';
    }

    if (key.endsWith('.png')) {
      return 'image/png';
    }

    console.error('[CloudClient] Tried to upload invalid file type', key);
    throw new Error('Tried to upload invalid file type');
  }

  /**
   * Upload a file to S3 in as a single part. Will fail if the file is larger
   * than 10GB.
   */
  private async doSinglePartUpload(
    file: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    progressCallback = (_progress: number) => {}
  ) {
    const key = path.basename(file);
    const stats = await fs.promises.stat(file);
    const stream = fs.createReadStream(file);
    const contentType = CloudClient.getContentType(key);

    const config: AxiosRequestConfig = {
      onUploadProgress: (event) =>
        progressCallback(Math.round((100 * event.loaded) / stats.size)),
      headers: { 'Content-Length': stats.size, 'Content-Type': contentType },
      validateStatus: () => true,

      // Without this, we buffer the whole file (which can be several GB)
      // into memory which is just a disaster. This makes me want to pick
      // a different HTTP library. https://github.com/axios/axios/issues/1045.
      maxRedirects: 0,
    };

    const signedUrl = await this.signPutUrl(key, stats.size);
    const start = new Date();
    const rsp = await axios.put(signedUrl, stream, config);
    const { status, data } = rsp;

    if (status >= 400) {
      console.error('[CloudClient] File upload failed', key, status, data);
      throw new Error('Uploading a file to the cloud failed');
    }

    console.info('[Cloud Client] Upload status:', rsp.status);
    const duration = (new Date().valueOf() - start.valueOf()) / 1000;

    console.info(
      '[CloudClient] Single part upload of',
      file,
      `(${stats.size} bytes) took `,
      duration,
      'seconds'
    );
  }

  /**
   * Upload a file to S3 with a multipart approach. Use this method for files
   * larger than 4.995GB as per the Cloudflare docs.
   */
  private async doMultiPartUpload(
    file: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    progressCallback = (_progress: number) => {}
  ) {
    const key = path.basename(file);
    const stats = await fs.promises.stat(file);
    const contentType = CloudClient.getContentType(key);

    const signedMultipartUpload = await this.createMultiPartUpload(
      key,
      stats.size
    );

    const start = new Date();
    const { urls } = signedMultipartUpload;

    let offset = 0;
    let remaining = stats.size;

    const numParts = urls.length;
    console.debug('[CloudClient] Multipart upload has', numParts, 'parts');

    // Part size must remain in sync with the client. See partSizeBytes in
    // CloudClient.ts. This must be greater than 5MB and smaller than 5GB.
    const partSizeBytes = 1 * 1024 ** 3;
    const etags: string[] = [];

    // Loop through each of the signed upload URLs, uploading to each in
    // turn. We need to keep track of the etags returned to use when
    // completing the multipart upload.
    for (let part = 0; part < numParts; part++) {
      console.debug('[CloudClient] Starting part', part + 1);

      const url = urls[part];
      const bytes = remaining > partSizeBytes ? partSizeBytes : remaining;

      // Create a stream to read from the file appropriate for this part.
      const stream = fs.createReadStream(file, {
        start: offset,
        end: offset + bytes,
      });

      const config: AxiosRequestConfig = {
        headers: { 'Content-Length': bytes, 'Content-Type': contentType },

        onUploadProgress: (event) => {
          // This determines the total progress made, accounting for the progress
          // we are through the parts. It falls a bit short on the final part, assuming
          // it's the same size as the others, but it's good enough.
          const previous = 100 * (part / numParts);
          const current = 100 * (event.loaded / bytes);
          const normalized = (1 / numParts) * current;
          const actual = Math.round(previous + normalized);
          progressCallback(actual);
        },

        validateStatus: () => true,

        // Without this, we buffer the whole file (which can be several GB)
        // into memory which is just a disaster. This makes me want to pick
        // a different HTTP library. https://github.com/axios/axios/issues/1045.
        maxRedirects: 0,
      };

      // eslint-disable-next-line no-await-in-loop
      const rsp = await axios.put(url, stream, config);
      const { status, headers, data } = rsp;

      if (status >= 400) {
        console.error(
          '[CloudClient] Multipart upload failed',
          key,
          status,
          data
        );
        throw new Error('Multipart upload failed');
      }

      const { etag } = headers;

      if (!etag) {
        console.error('[CloudClient] No etag in response headers', key);
        throw new Error('Multipart upload failed');
      }

      // Weirdly axios returns this with quotes included, strip them off.
      const etagNoQuotes = etag.replaceAll('"', '');
      etags.push(etagNoQuotes);

      console.debug(
        '[CloudClient] Finished part',
        part + 1,
        'etag',
        etagNoQuotes
      );

      // Increment the offset into the file for the next go round the loop.
      offset += bytes;
      remaining -= bytes;

      // Update the progress bar on the frontend. It's a bit worse we only
      // update every time we complete a part here (which are 1GB each), so
      // UX probably a bit worse. Maybe can do better.
      progressCallback(Math.round((100 * offset) / stats.size));
    }

    await this.completeMultiPartUpload(key, etags);
    const duration = (new Date().valueOf() - start.valueOf()) / 1000;

    console.info(
      '[CloudClient] Multipart part upload of',
      file,
      `(${stats.size} bytes) took `,
      duration,
      'seconds'
    );
  }
}
