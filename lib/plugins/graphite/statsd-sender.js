'use strict';

const dgram = require('dgram');
const Sender = require('./sender');

class StatsDSender extends Sender {
  constructor (host, port, bulkSize) {
    super(host, port, bulkSize);

    const StatsD = require('hot-shots');
    this.client = new StatsD({
      host: this.host,
      port: this.port,
    });
  }
  get facility() {
    return 'StatsD';
  }

  bulk(data) {
    const self = this;
    self.log(data);

    const tagKeys = [
      'domain',
      'uri',
      'browser',
      'network',
      'aggType',
    ];
    const underscoreR = new RegExp(/[_]/g);
    const contentTypeR = new RegExp(/^(contentTypes)[.]([^.]+)[.](.*)/);
    const pageTimingsR = new RegExp(/^statistics[.]timings[.](pageTimings)[.](.*)/);
    const pageSummaryR = new RegExp(/(.*[.]pageSummary)[.]([^.]+)[.]([^.]+)[.]([^.]+)[.]([^.]+)[.]([^.]+)[.]?(.*?)[.]?(\d+|avg|max|mdev|mean|median|min|p\d+|total)?[:]([-]?\d+)/);

    return new Promise((resolve, reject) => {
      data.split('\n').forEach(function(line) {
        if (line) {
          let extractParts = pageSummaryR.exec(line);
          if (extractParts) {
            let matchObj = {
              prefix: extractParts[1],
              domain: extractParts[2].replace(underscoreR, '.'),
              uri: extractParts[3].replace(underscoreR, '/'),
              browser: extractParts[4],
              network: extractParts[5],
              phase: extractParts[6],
              metric: extractParts[7],
              aggType: extractParts[8],
              value: Number(extractParts[9]),
              tags: [],
            };
            let subMatchObj;
            if (matchObj.metric) {
              if (subMatchObj = contentTypeR.exec(matchObj.metric)) {
                // Here contentTypes.css.contentSize becomes metric=contentSize, [contentTypes:css]
                matchObj.metric = subMatchObj.pop();
                matchObj.tags.push(subMatchObj[1] + ':' + subMatchObj[2]);
              } else if (subMatchObj = pageTimingsR.exec(matchObj.metric)) {
                // Here statistics.timings.pageTimings.<tags> becomes metric=pageTimings, [timing:<tag>]
                matchObj.metric = subMatchObj[1];
                matchObj.tags.push('timing:' + subMatchObj.pop());
              }
              matchObj.tags
            }
            tagKeys.forEach(function(key) {
              if (matchObj[key]) {
                matchObj.tags.push(key + ':' + matchObj[key]);
              }
            });
            self.client.gauge(matchObj.prefix + '.' + matchObj.phase + '.' + matchObj.metric, matchObj.value, matchObj.tags);
            self.log(matchObj);
          } else {
            self.log('Skipping metric', line);
          }
        }
      });
      return resolve(true);
    });
  }
}

module.exports = StatsDSender;
