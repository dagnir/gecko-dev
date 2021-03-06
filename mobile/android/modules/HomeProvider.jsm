// -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; js2-basic-offset: 2; js2-skip-preprocessor-directives: t; -*-
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = [ "HomeProvider" ];

const { utils: Cu, classes: Cc, interfaces: Ci } = Components;

Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Sqlite.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

/*
 * XXX: Add migration logic to getDatabaseConnection if you ever rev SCHEMA_VERSION.
 *
 * SCHEMA_VERSION history:
 *   1: Create HomeProvider (bug 942288)
 */
const SCHEMA_VERSION = 1;

XPCOMUtils.defineLazyGetter(this, "DB_PATH", function() {
  return OS.Path.join(OS.Constants.Path.profileDir, "home.sqlite");
});

const PREF_STORAGE_LAST_SYNC_TIME_PREFIX = "home.storage.lastSyncTime.";
const PREF_SYNC_WIFI_ONLY = "home.sync.wifiOnly";
const PREF_SYNC_CHECK_INTERVAL_SECS = "home.sync.checkIntervalSecs";

XPCOMUtils.defineLazyGetter(this, "gSyncCheckIntervalSecs", function() {
  return Services.prefs.getIntPref(PREF_SYNC_CHECK_INTERVAL_SECS);
});

XPCOMUtils.defineLazyServiceGetter(this,
  "gUpdateTimerManager", "@mozilla.org/updates/timer-manager;1", "nsIUpdateTimerManager");

/**
 * All SQL statements should be defined here.
 */
const SQL = {
  createItemsTable:
    "CREATE TABLE items (" +
      "_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "dataset_id TEXT NOT NULL, " +
      "url TEXT," +
      "title TEXT," +
      "description TEXT," +
      "image_url TEXT," +
      "filter TEXT," +
      "created INTEGER" +
    ")",

  insertItem:
    "INSERT INTO items (dataset_id, url, title, description, image_url, filter, created) " +
      "VALUES (:dataset_id, :url, :title, :description, :image_url, :filter, :created)",

  deleteFromDataset:
    "DELETE FROM items WHERE dataset_id = :dataset_id"
}

/**
 * Technically this function checks to see if the user is on a local network,
 * but we express this as "wifi" to the user.
 */
function isUsingWifi() {
  let network = Cc["@mozilla.org/network/network-link-service;1"].getService(Ci.nsINetworkLinkService);
  return (network.linkType === Ci.nsINetworkLinkService.LINK_TYPE_WIFI || network.linkType === Ci.nsINetworkLinkService.LINK_TYPE_ETHERNET);
}

function getNowInSeconds() {
  return Math.round(Date.now() / 1000);
}

function getLastSyncPrefName(datasetId) {
  return PREF_STORAGE_LAST_SYNC_TIME_PREFIX + datasetId;
}

// Whether or not we've registered an update timer.
var gTimerRegistered = false;

// Map of datasetId -> { interval: <integer>, callback: <function> }
var gSyncCallbacks = {};

/**
 * nsITimerCallback implementation. Checks to see if it's time to sync any registered datasets.
 *
 * @param timer The timer which has expired.
 */
function syncTimerCallback(timer) {
  for (let datasetId in gSyncCallbacks) {
    let lastSyncTime = 0;
    try {
      lastSyncTime = Services.prefs.getIntPref(getLastSyncPrefName(datasetId));
    } catch(e) { }

    let now = getNowInSeconds();
    let { interval: interval, callback: callback } = gSyncCallbacks[datasetId];

    if (lastSyncTime < now - interval) {
      let success = HomeProvider.requestSync(datasetId, callback);
      if (success) {
        Services.prefs.setIntPref(getLastSyncPrefName(datasetId), now);
      }
    }
  }
}

this.HomeProvider = Object.freeze({
  /**
   * Returns a storage associated with a given dataset identifer.
   *
   * @param datasetId
   *        (string) Unique identifier for the dataset.
   *
   * @return HomeStorage
   */
  getStorage: function(datasetId) {
    return new HomeStorage(datasetId);
  },

  /**
   * Checks to see if it's an appropriate time to sync.
   *
   * @param datasetId Unique identifier for the dataset to sync.
   * @param callback Function to call when it's time to sync, called with datasetId as a parameter.
   *
   * @return boolean Whether or not we were able to sync.
   */
  requestSync: function(datasetId, callback) {
    // Make sure it's a good time to sync.
    if (Services.prefs.getBoolPref(PREF_SYNC_WIFI_ONLY) && !isUsingWifi()) {
      Cu.reportError("HomeProvider: Failed to sync because device is not on a local network");
      return false;
    }

    callback(datasetId);
    return true;
  },

  /**
   * Specifies that a sync should be requested for the given dataset and update interval.
   *
   * @param datasetId Unique identifier for the dataset to sync.
   * @param interval Update interval in seconds. By default, this is throttled to 3600 seconds (1 hour).
   * @param callback Function to call when it's time to sync, called with datasetId as a parameter.
   */
  addPeriodicSync: function(datasetId, interval, callback) {
    // Warn developers if they're expecting more frequent notifications that we allow.
    if (interval < gSyncCheckIntervalSecs) {
      Cu.reportError("HomeProvider: Warning for dataset " + datasetId +
        " : Sync notifications are throttled to " + gSyncCheckIntervalSecs + " seconds");
    }

    gSyncCallbacks[datasetId] = {
      interval: interval,
      callback: callback
    };

    if (!gTimerRegistered) {
      gUpdateTimerManager.registerTimer("home-provider-sync-timer", syncTimerCallback, gSyncCheckIntervalSecs);
      gTimerRegistered = true;
    }
  },

  /**
   * Removes a periodic sync timer.
   *
   * @param datasetId Dataset to sync.
   */
  removePeriodicSync: function(datasetId) {
    delete gSyncCallbacks[datasetId];
    Services.prefs.clearUserPref(getLastSyncPrefName(datasetId));
    // You can't unregister a update timer, so we don't try to do that.
  }
});

var gDatabaseEnsured = false;

/**
 * Opens a database connection and makes sure that the database schema version
 * is correct, performing migrations if necessary. Consumers should be sure
 * to close any database connections they open.
 *
 * @return Promise
 * @resolves Handle on an opened SQLite database.
 */
function getDatabaseConnection() {
  return Task.spawn(function get_database_connection_task() {
    let db = yield Sqlite.openConnection({ path: DB_PATH });
    if (gDatabaseEnsured) {
      throw new Task.Result(db);
    }

    try {
      // Check to see if we need to perform any migrations.
      // XXX: We will need to add migration logic if we ever rev SCHEMA_VERSION.
      let dbVersion = yield db.getSchemaVersion();
      if (parseInt(dbVersion) < SCHEMA_VERSION) {
        // For schema v1, create the items table and set the schema version.
        yield db.execute(SQL.createItemsTable);
        yield db.setSchemaVersion(SCHEMA_VERSION);
      }
    } catch(e) {
      // Close the DB connection before passing the exception to the consumer.
      yield db.close();
      throw e;
    }

    gDatabaseEnsured = true;
    throw new Task.Result(db);
  });
}

this.HomeStorage = function(datasetId) {
  this.datasetId = datasetId;
};

HomeStorage.prototype = {
  /**
   * Saves data rows to the DB.
   *
   * @param data
   *        (array) JSON array of row items
   *
   * @return Promise
   * @resolves When the operation has completed.
   */
  save: function(data) {
    return Task.spawn(function save_task() {
      let db = yield getDatabaseConnection();
      try {
        // Insert data into DB.
        for (let item of data) {
          // XXX: Directly pass item as params? More validation for item? Batch insert?
          let params = {
            dataset_id: this.datasetId,
            url: item.url,
            title: item.title,
            description: item.description,
            image_url: item.image_url,
            filter: item.filter,
            created: Date.now()
          };
          yield db.executeCached(SQL.insertItem, params);
        }
      } finally {
        yield db.close();
      }
    }.bind(this));
  },

  /**
   * Deletes all rows associated with this storage.
   *
   * @return Promise
   * @resolves When the operation has completed.
   */
  deleteAll: function() {
    return Task.spawn(function delete_all_task() {
      let db = yield getDatabaseConnection();
      try {
        let params = { dataset_id: this.datasetId };
        yield db.executeCached(SQL.deleteFromDataset, params);
      } finally {
        yield db.close();
      }
    }.bind(this));
  }
};
