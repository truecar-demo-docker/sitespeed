'use strict';

const fs = require('fs-extra');
const path = require('path');
const AWS = require('aws-sdk');
const readdir = require('recursive-readdir');
const pLimit = require('p-limit');

const log = require('intel').getLogger('sitespeedio.plugin.s3');
const throwIfMissing = require('../../support/util').throwIfMissing;
const { getContentType } = require('./contentType');
const dynamodbTableName = process.env.DYNAMODB_TABLE_NAME

// PATTERN is /sitespeed.io/sitespeed-result/<site>/<date>/pages/<site>/<uri1>[/...<uriN>]/index.html
const fileRegexp = /[/]([0-9-]+)[/]pages[/]([^/]+)(.*)[/]index\.html$/;

function createS3(s3Options) {
  let endpoint = s3Options.endpoint || 's3.amazonaws.com';
  const options = {
    endpoint: new AWS.Endpoint(endpoint),
    accessKeyId: s3Options.key,
    secretAccessKey: s3Options.secret,
    signatureVersion: 'v4'
  };
  // You can also set some extra options see
  // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#constructor-property
  Object.assign(options, s3Options.options);
  return new AWS.S3(options);
}

function createDynamoDB() {
  AWS.config.update({region: process.env.AWS_DEFAULT_REGION || 'us-west-2'});
  return new AWS.DynamoDB({apiVersion: '2012-08-10'});
}

async function updateDynamoDB(file, dynamodb) {
  return new Promise((resolve, reject) => {
    const groups = file.match(fileRegexp);
    if (groups) {
      if (dynamodbTableName) {
        const shortstamp = groups[1].substring(0,15);
        const site = groups[2];
        const uri = groups[3] || '/';
        log.info(
          'Marking metadata in dynamodb table name =', dynamodbTableName,
          'shortstamp =', shortstamp,
          'site =', site,
          'uri =', uri,
        );
        const dynamoEntry = {
          TableName: dynamodbTableName,
          Item: {
            'datetime': {'S': shortstamp},
            'site': {'S': site},
            'uri': {'S': uri},
            'url': {'S': site + uri},
            'dst': {'S': file},
            'mobile': {'BOOL': process.env.TEST_BROWSER_MOBILE ? true : false},
            'browser': {'S': process.env.TEST_BROWSER || 'chrome'},
            'network': {'S': process.env.TEST_NETWORK_PROFILE || 'native'},
            'TTL': {'N': (Math.floor(Date.now() / 1000) + 60 * 24 * 3600).toString()}
          }
        };

        try {
          dynamodb.putItem(dynamoEntry, function(err, data) {
            if (err) {
              log.error('Could not write to dynamodb', err, dynamoEntry);
            } else {
              log.info('Updated dynamodb table', file);
            }
          });
        } catch (e) {
          log.error('Some dynamodb error', e);
        }
      } else {
        log.error('Missing dynamodb name with match', groups);
      }
    } else {
        // log.info('Skipping', file);
    }
    return resolve();
  });
}

async function upload(dir, s3Options, prefix) {
  const s3 = createS3(s3Options);
  const dynamodb = createDynamoDB();
  const files = await readdir(dir);
  // Backward compability naming for old S3 plugin
  const limit = pLimit(s3Options.maxAsyncS3 || 20);
  const promises = [];

  for (let file of files) {
    promises.push(limit(() => uploadFile(file, s3, s3Options, prefix, dir, dynamodb)));
    promises.push(updateDynamoDB(file, dynamodb));
  }
  return Promise.all(promises);
}

async function uploadFile(file, s3, s3Options, prefix, baseDir, dynamodb) {
  const stream = fs.createReadStream(file);
  const contentType = getContentType(file);
  return new Promise((resolve, reject) => {
    const onUpload = err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const options = { partSize: 10 * 1024 * 1024, queueSize: 1 };
    // See  https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property
    const subPath = path.relative(baseDir, file);
    const params = {
      Body: stream,
      Bucket: s3Options.bucketname,
      ContentType: contentType,
      Key: path.join(s3Options.path || prefix, subPath),
      StorageClass: s3Options.storageClass || 'STANDARD'
    };

    if (s3Options.acl) {
      params.ACL = s3Options.acl;
    }
    // Override/set all the extra options you need
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property
    Object.assign(params, s3Options.params);

    s3.upload(params, options, onUpload);
  });
}

module.exports = {
  open(context, options) {
    this.s3Options = options.s3;
    this.make = context.messageMaker('s3').make;
    throwIfMissing(this.s3Options, ['bucketname'], 's3');
    if (this.s3Options.key || this.s3Options.secret) {
      throwIfMissing(this.s3Options, ['key', 'secret'], 's3');
    }
    this.storageManager = context.storageManager;
  },

  async processMessage(message, queue) {
    if (message.type === 'html.finished') {
      const make = this.make;
      const s3Options = this.s3Options;
      const baseDir = this.storageManager.getBaseDir();

      log.info(
        `Uploading ${baseDir} to S3 bucket ${
          s3Options.bucketname
        }, this can take a while ...`
      );

      try {
        await upload(
          baseDir,
          s3Options,
          this.storageManager.getStoragePrefix()
        );
        log.info('Finished upload to s3');
        if (s3Options.removeLocalResult) {
          await fs.remove(baseDir);
          log.debug(`Removed local files and directory ${baseDir}`);
        }
      } catch (e) {
        queue.postMessage(make('error', e));
        log.error('Could not upload to S3', e);
      }
      queue.postMessage(make('s3.finished'));
    }
  }
};
