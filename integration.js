"use strict";

const request = require("request");
const _ = require("lodash");
const config = require("./config/config");
const async = require("async");
const fs = require("fs");

let Logger;
let requestWithDefaults;
let previousDomainRegexAsString = "";
let previousIpRegexAsString = "";
let domainBlacklistRegex = null;
let ipBlacklistRegex = null;

const MAX_DOMAIN_LABEL_LENGTH = 63;
const MAX_ENTITY_LENGTH = 100;
const MAX_PARALLEL_LOOKUPS = 10;
const IGNORED_IPS = new Set(["127.0.0.1", "255.255.255.255", "0.0.0.0"]);

/**
 *
 * @param entities
 * @param options
 * @param cb
 */
function startup(logger) {
  Logger = logger;
  let defaults = {};

  if (
    typeof config.request.cert === "string" &&
    config.request.cert.length > 0
  ) {
    defaults.cert = fs.readFileSync(config.request.cert);
  }

  if (typeof config.request.key === "string" && config.request.key.length > 0) {
    defaults.key = fs.readFileSync(config.request.key);
  }

  if (
    typeof config.request.passphrase === "string" &&
    config.request.passphrase.length > 0
  ) {
    defaults.passphrase = config.request.passphrase;
  }

  if (typeof config.request.ca === "string" && config.request.ca.length > 0) {
    defaults.ca = fs.readFileSync(config.request.ca);
  }

  if (
    typeof config.request.proxy === "string" &&
    config.request.proxy.length > 0
  ) {
    defaults.proxy = config.request.proxy;
  }

  requestWithDefaults = request.defaults(defaults);
}

function _setupRegexBlacklists(options) {
  if (
    options.domainBlacklistRegex !== previousDomainRegexAsString &&
    options.domainBlacklistRegex.length === 0
  ) {
    Logger.debug("Removing Domain Blacklist Regex Filtering");
    previousDomainRegexAsString = "";
    domainBlacklistRegex = null;
  } else {
    if (options.domainBlacklistRegex !== previousDomainRegexAsString) {
      previousDomainRegexAsString = options.domainBlacklistRegex;
      Logger.debug(
        { domainBlacklistRegex: previousDomainRegexAsString },
        "Modifying Domain Blacklist Regex"
      );
      domainBlacklistRegex = new RegExp(options.domainBlacklistRegex, "i");
    }
  }

  if (
    options.ipBlacklistRegex !== previousIpRegexAsString &&
    options.ipBlacklistRegex.length === 0
  ) {
    Logger.debug("Removing IP Blacklist Regex Filtering");
    previousIpRegexAsString = "";
    ipBlacklistRegex = null;
  } else {
    if (options.ipBlacklistRegex !== previousIpRegexAsString) {
      previousIpRegexAsString = options.ipBlacklistRegex;
      Logger.debug(
        { ipBlacklistRegex: previousIpRegexAsString },
        "Modifying IP Blacklist Regex"
      );
      ipBlacklistRegex = new RegExp(options.ipBlacklistRegex, "i");
    }
  }
}

function doLookup(entities, options, cb) {
  let lookupResults = [];
  let tasks = [];

  _setupRegexBlacklists(options);

  Logger.debug(entities);

  entities.forEach(entity => {
    if (!_isInvalidEntity(entity) && !_isEntityBlacklisted(entity, options)) {
      //do the lookup
      let requestOptions = {
        method: "GET",
        auth: {
          user: options.user,
          pass: options.apiKey
        },
        json: true
      };

      if (entity.isDomain || entity.isIPv4) {
        requestOptions.uri = `${options.host}/v2/dns/passive`;
        requestOptions.qs = {
          query: `${entity.value}`
        };
      } else {
        return;
      }

      Logger.trace({ uri: requestOptions.uri }, "Request URI");

      tasks.push(function(done) {
        requestWithDefaults(requestOptions, function(error, res, body) {
          let processedResult = handleRestError(error, entity, res, body);

          if (processedResult.error) {
            done(processedResult);
            return;
          }

          done(null, processedResult);
        });
      });
    }
  });

  async.parallelLimit(tasks, MAX_PARALLEL_LOOKUPS, (err, results) => {
    if (err) {
      Logger.error({ err: err }, "Error");
      cb(err);
      return;
    }

    results.forEach(result => {
      if (result.body === null || _isMiss(result.body)) {
        lookupResults.push({
          entity: result.entity,
          data: null
        });
      } else {
        result.body.results = result.body.results.splice(0, options.records);
        lookupResults.push({
          entity: result.entity,
          data: {
            summary: [],
            details: result.body
          }
        });
      }
    });

    Logger.trace({ lookupResults }, "Results");
    cb(null, lookupResults);
  });
}

function doWhoisLookup(entity, options) {
  return function(done) {
    let requestOptions = {
      method: "GET",
      uri: `${options.host}/v2/whois`,
      auth: {
        user: options.user,
        pass: options.apiKey
      },
      qs: { query: `${entity.value}` },
      json: true
    };

    request(requestOptions, (error, response, body) => {
      let processedResult = handleRestError(error, entity, response, body);

      if (processedResult.error) {
        done(processedResult);
        return;
      }

      done(null, processedResult.body);
    });
  };
}

function doPassiveLookup(entity, options) {
  return function(done) {
    let requestOptions = {
      method: "GET",
      uri: `${options.host}/v2/enrichment`,
      auth: {
        user: options.user,
        pass: options.apiKey
      },
      qs: { query: `${entity.value}` },
      json: true
    };

    request(requestOptions, (error, response, body) => {
      let processedResult = handleRestError(error, entity, response, body);

      if (processedResult.error) {
        done(processedResult);
        return;
      }

      done(null, processedResult.body);
    });
  };
}

function doMalwareLookup(entity, options) {
  return function(done) {
    let requestOptions = {
      method: "GET",
      uri: `${options.host}/v2/enrichment/malware`,
      auth: {
        user: options.user,
        pass: options.apiKey
      },
      qs: { query: `${entity.value}` },
      json: true
    };

    request(requestOptions, (error, response, body) => {
      let processedResult = handleRestError(error, entity, response, body);

      if (processedResult.error) {
        done(processedResult);
        return;
      }

      done(null, processedResult.body);
    });
  };
}

function doOsintLookup(entity, options) {
  return function(done) {
    let requestOptions = {
      method: "GET",
      uri: `${options.host}/v2/enrichment/osint`,
      auth: {
        user: options.user,
        pass: options.apiKey
      },
      qs: { query: `${entity.value}` },
      json: true
    };

    request(requestOptions, (error, response, body) => {
      let processedResult = handleRestError(error, entity, response, body);

      if (processedResult.error) {
        done(processedResult);
        return;
      }

      done(null, processedResult.body);
    });
  };
}

function onDetails(lookupObject, options, cb) {
  async.parallel(
    {
      whois: doWhoisLookup(lookupObject.entity, options),
      passive: doPassiveLookup(lookupObject.entity, options),
      malware: doMalwareLookup(lookupObject.entity, options),
      osint: doOsintLookup(lookupObject.entity, options)

    },
    (err, results) => {
      if (err) {
        return cb(err);
      }

      results.passive.subdomains = results.passive.subdomains.splice(0,100);
      //store the results into the details object so we can access them in our template
      lookupObject.data.details.whois = results.whois;
      lookupObject.data.details.passive = results.passive;
      lookupObject.data.details.malware = results.malware.results.splice(0, options.records);
      lookupObject.data.details.osint = results.osint.results.splice(0, options.records);

      Logger.trace({lookup: lookupObject.data}, "Looking at the data after on details.");

      cb(null, lookupObject.data);
    }
  );
}

function handleRestError(error, entity, res, body) {
  let result;

  if (error) {
    return {
      error: error,
      detail: "HTTP Request Error"
    };
  }
  if (res.statusCode === 200) {
    // we got data!
    result = {
      entity: entity,
      body: body
    };
  } else if (res.statusCode === 404) {
    // no result found
    result = {
      entity: entity,
      body: null
    };
  } else if (res.statusCode === 202) {
    // no result found
    result = {
      entity: entity,
      body: null
    };
  } else {
    // unexpected status code
    result = {
      error: body,
      detail: `${body.error}: ${body.message}`
    };
  }
  return result;
}

function _isInvalidEntity(entity) {
  // Domains should not be over 100 characters long so if we get any of those we don't look them up
  if (entity.value.length > MAX_ENTITY_LENGTH) {
    return true;
  }

  // Domain labels (the parts in between the periods, must be 63 characters or less
  if (entity.isDomain) {
    const invalidLabel = entity.value.split(".").find(label => {
      return label.length > MAX_DOMAIN_LABEL_LENGTH;
    });

    if (typeof invalidLabel !== "undefined") {
      return true;
    }
  }

  if (entity.isIPv4 && IGNORED_IPS.has(entity.value)) {
    return true;
  }

  return false;
}

function _isEntityBlacklisted(entity, options) {
  const blacklist = options.blacklist;

  Logger.trace(
    { blacklist: blacklist },
    "checking to see what blacklist looks like"
  );

  if (_.includes(blacklist, entity.value.toLowerCase())) {
    return true;
  }

  if (entity.isIP && !entity.isPrivateIP) {
    if (ipBlacklistRegex !== null) {
      if (ipBlacklistRegex.test(entity.value)) {
        Logger.debug({ ip: entity.value }, "Blocked BlackListed IP Lookup");
        return true;
      }
    }
  }

  if (entity.isDomain) {
    if (domainBlacklistRegex !== null) {
      if (domainBlacklistRegex.test(entity.value)) {
        Logger.debug(
          { domain: entity.value },
          "Blocked BlackListed Domain Lookup"
        );
        return true;
      }
    }
  }

  return false;
}

function _isMiss(body) {
  if (!body) {
    return true;
  }
}

function validateOptions(userOptions, cb) {
  let errors = [];
  if (
    typeof userOptions.apiKey.value !== "string" ||
    (typeof userOptions.apiKey.value === "string" &&
      userOptions.apiKey.value.length === 0)
  ) {
    errors.push({
      key: "apiKey",
      message: "You must provide a PassiveTotal API key"
    });
  }

  if (
    typeof userOptions.user.value !== "string" ||
    (typeof userOptions.user.value === "string" &&
      userOptions.user.value.length === 0)
  ) {
    errors.push({
      key: "user",
      message: "You must provide a PassiveTotal Username"
    });
  }
  cb(null, errors);
}

module.exports = {
  doLookup: doLookup,
  onDetails: onDetails,
  startup: startup,
  validateOptions: validateOptions
};
