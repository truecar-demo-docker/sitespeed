"use strict";

const dgram = require("dgram");
const Sender = require("./sender");

class StatsDSender extends Sender {
  constructor(host, port, bulkSize) {
    super(host, port, bulkSize);

    const StatsD = require("hot-shots");
    this.client = new StatsD({
      host: this.host,
      port: this.port
    });
  }
  get facility() {
    return "StatsD";
  }

  bulk(data) {
    const self = this;
    self.log(data);

    const tagKeys = ["domain", "uri", "browser", "network", "aggType"];
    /*
    Thse are taken from v10.1.x, see https://www.sitespeed.io/documentation/sitespeed.io/metrics/#list-configured-metrics
    largestassets.summary.image.0.transferSize
    browsertime.pageSummary.statistics.timings.pageTimings
    browsertime.pageSummary.statistics.timings.rumSpeedIndex
    browsertime.pageSummary.statistics.timings.fullyLoaded
    browsertime.pageSummary.statistics.timings.firstPaint
    browsertime.pageSummary.statistics.timings.timeToDomContentFlushed
    browsertime.pageSummary.statistics.timings.timeToContentfulPaint
    browsertime.pageSummary.statistics.timings.timeToFirstInteractive
    browsertime.pageSummary.statistics.timings.loadEventEnd
    browsertime.pageSummary.statistics.timings.userTimings
    browsertime.pageSummary.statistics.timings.paintTiming
    browsertime.pageSummary.statistics.visualMetrics.*
    browsertime.pageSummary.statistics.custom.*
    browsertime.pageSummary.statistics.console.error
    browsertime.pageSummary.statistics.console.warning
    browsertime.pageSummary.statistics.cpu.categories.*
    browsertime.pageSummary.statistics.cpu.events.*
    browsertime.pageSummary.statistics.cpu.longTasks.*
    browsertime.pageSummary.statistics.cdp.performance.RecalcStyleCount
    browsertime.pageSummary.statistics.errors
    browsertime.summary.firstPaint
    browsertime.summary.rumSpeedIndex
    browsertime.summary.timeToDomContentFlushed
    browsertime.summary.fullyLoaded
    browsertime.summary.pageTimings
    browsertime.summary.userTimings.marks
    browsertime.summary.userTimings.measures
    browsertime.summary.visualMetrics.*
    browsertime.summary.custom.*
    coach.summary.score.*
    coach.summary.performance.score.*
    coach.summary.privacy.score.*
    coach.summary.bestpractice.score.*
    coach.summary.accessibility.score.*
    coach.pageSummary.advice.score
    coach.pageSummary.advice.performance.score
    coach.pageSummary.advice.privacy.score
    coach.pageSummary.advice.bestpractice.score
    coach.pageSummary.advice.accessibility.score
    coach.pageSummary.advice.info.documentHeight
    coach.pageSummary.advice.info.domElements
    coach.pageSummary.advice.info.domDepth
    coach.pageSummary.advice.info.iframes
    coach.pageSummary.advice.info.scripts
    coach.pageSummary.advice.info.localStorageSize
    pagexray.pageSummary.contentTypes
    pagexray.pageSummary.transferSize
    pagexray.pageSummary.contentSize
    pagexray.pageSummary.requests
    pagexray.pageSummary.firstParty
    pagexray.pageSummary.thirdParty
    pagexray.pageSummary.responseCodes
    pagexray.pageSummary.expireStats
    pagexray.pageSummary.totalDomains
    pagexray.pageSummary.lastModifiedStats
    pagexray.pageSummary.cookieStats
    pagexray.summary.contentTypes
    pagexray.summary.transferSize
    pagexray.summary.contentSize
    pagexray.summary.requests
    pagexray.summary.firstParty
    pagexray.summary.thirdParty
    pagexray.summary.responseCodes
    pagexray.summary.expireStats
    pagexray.summary.domains
    pagexray.summary.lastModifiedStats
    pagexray.summary.cookieStats
    thirdparty.pageSummary.category.*.requests.*
    thirdparty.pageSummary.category.*.tools.*
    thirdparty.pageSummary.requests.*
    */
    const underscoreR = new RegExp(/[_]/g);
    const contentTypeR = new RegExp(
      /^(firstParty|thirdParty)?[.]?(contentTypes)[.]([^.]+)[.](.*)/
    );
    const pageTimingsR = new RegExp(
      /^statistics[.](cpu|timings)[.](categories|events|longTasks|pageTimings|paintTiming)[.](.*)/
    );
    const pageSummaryR = new RegExp(
      /(.*[.]pageSummary)[.]([^.]+)[.]([^.]+)[.]([^.]+)[.]([^.]+)[.]([^.]+)[.]?(.*?)[.]?(\d+|avg|max|mdev|mean|median|min|p\d+|stddev|total)?[:]([-]?\d+)/
    );

    return new Promise((resolve, reject) => {
      data.split("\n").forEach(function(line) {
        if (line) {
          let extractParts = pageSummaryR.exec(line);
          if (extractParts) {
            let matchObj = {
              prefix: extractParts[1],
              domain: extractParts[2].replace(underscoreR, "."),
              uri: extractParts[3].replace(underscoreR, "/"),
              browser: extractParts[4],
              network: extractParts[5],
              phase: extractParts[6],
              metric: extractParts[7],
              aggType: extractParts[8],
              value: Number(extractParts[9]),
              tags: []
            };
            let subMatchObj;
            if (matchObj.metric) {
              if ((subMatchObj = contentTypeR.exec(matchObj.metric))) {
                if (subMatchObj[1]) {
                  // Here firstParty.contentTypes.css.contentSize becomes metric=contentSize, [party:firstParty,contentTypes:css]
                  matchObj.metric = subMatchObj.pop();
                  matchObj.tags.push("party:" + subMatchObj[1]);
                  matchObj.tags.push(subMatchObj[2] + ":" + subMatchObj[3]);
                } else {
                  self.log("Skipping contentType", line);
                  return resolve(true);
                }
              } else if ((subMatchObj = pageTimingsR.exec(matchObj.metric))) {
                // Here statistics.timings.pageTimings.<tags> becomes metric=timings, [pagetTimings:<tag>]
                matchObj.metric = subMatchObj[1];
                matchObj.tags.push(subMatchObj[2] + ":" + subMatchObj.pop());
              }
              matchObj.tags;
            }
            tagKeys.forEach(function(key) {
              if (matchObj[key]) {
                matchObj.tags.push(key + ":" + matchObj[key]);
              }
            });
            if (
              !("aggType" in matchObj) ||
              [undefined, "median", "max", "min", "200", "204", "301", "302", "304", "400", "401", "403", "404", "429", "500", "501", "502", "503"].includes(matchObj.aggType)
            ) {
              self.client.gauge(
                matchObj.prefix + "." + matchObj.phase + "." + matchObj.metric,
                matchObj.value,
                matchObj.tags
              );
              self.log(matchObj);
            } else {
              self.log("Skipping parsed metric", line);
            }
          } else {
            self.log("Skipping metric", line);
          }
        }
      });
      return resolve(true);
    });
  }
}

module.exports = StatsDSender;
