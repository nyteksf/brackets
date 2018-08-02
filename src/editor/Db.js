/*
 * Copyright (c) 2012 - present Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

  /*******************************************************************\
  *                                                                   *
  *       WebSQL/SQLite3 500 MB Persistence of Unsaved Changes        *
  *                                                                   *
  * ----------------------------------------------------------------- *
  *                    DB Structure: 4 * 125MB Tables                 *
  * ----------------------------------------------------------------- *
  *                                                                   *
  *               Table 1                       Table 2               *
  *    +----------------------------+----------------------------+    *
  *    |      "cursorpos_coords"    |     "scrollpos_coords"     |    *
  *    +----------------------------+----------------------------+    *
  *    |    int__CursorPos INTEGER  |   int__ScrollPos INTEGER   |    *
  *    +----------------------------+----------------------------+    *
  *                                                                   *
  *               Table 3                       Table 4               *
  *    +----------------------------+----------------------------+    *
  *    |    "undo_redo_history"     |    "unsaved_doc_changes"   |    *
  *    +----------------------------+----------------------------+    *
  *    |    str__DocHistory TEXT    |      str__DocTxt TEXT      |    *
  *    +----------------------------+----------------------------+    *
  *                                                                   *
  * ----------------------------------------------------------------- *
  *                                                                   *
  *     The db module interacts with the editor while shadowing its   *
  *		assigned codemirror for a given doc in order to preserve any  *
  *		unsaved changes. This module features database config	 	  *
  *		info, and methods for db instantiation and CRUD. There are	  *
  *		four tables created in total amounting to 500MB in total. 	  *
  *		These tables are each respectively named "cursorpos_coords",  *
  *		"scrollpos_coords", "undo_redo_history" and 				  *
  *		"unsaved_doc_changes". In order, these contain the last	 	  *
  *		known document information as related to cursor	  			  *
  *		and scroll positioning, as well as the undo/redo history 	  *
  *		and document text. Change data is stored by full filepath 	  *
  *		which is used as the sessionId. Keyup events in a focused 	  *
  *		editor are what trigger syncing of all current history 		  *
  *		data to the database. 									      *
  *                                                                   *
  \*******************************************************************/
define(function (require, exports, module) {
    'use strict';

    var Editor = require("editor/Editor"),
        PreferencesManager = require("preferences/PreferencesManager"),
    	Strings = require("strings"),
        DocumentManager = require("document/DocumentManager"),
    	CompressionUtils = require("thirdparty/rawdeflate"),
        CompressionUtils = require("thirdparty/rawinflate"),
        He = require("thirdparty/he");

    // Config settings
    var DB_NAME    = 'change_history_db',
        DB_VERSION = '1.0',
        DB_DESC    = 'Feature: Hot Close',
        DB_SIZE_MB = 500;

    var database   = window.openDatabase(DB_NAME,
                                    DB_VERSION,
                                    DB_DESC,
                                    DB_SIZE_MB * 1024 * 1024);

    // Static db references
    var tables = [
            "cursorpos_coords",
            "scrollpos_coords",
            "undo_redo_history",
            "unsaved_doc_changes"
        ],
        keyNames = [
            "int__CursorPos",
            "int__ScrollPos",
            "str__DocHistory",
            "str__DocTxt"
        ];

    // Initialize 'hot close' setting
    var HOT_CLOSE = "hotClose";

    PreferencesManager.definePreference(HOT_CLOSE, "boolean", true, {
        description: Strings.DESCRIPTION_HOT_CLOSE
    });

    var hotClose = PreferencesManager.get(HOT_CLOSE);
    
    // Debounce syncing of new unsaved changes to db
    var timer = null;
    function debouncedSync(doc, delay) {
		var result = new $.Deferred();
		try {

			return function () {
				clearTimeout(timer);
				timer = setTimeout(function () {
					captureUnsavedDocChanges(doc);
				}, delay || 1250);
				result.resolve();
			};
		} catch (error) {
			console.log(error);
			result.reject();
		}

		return result.promise();
    };

    // Creates a table in current db
    function createTable (table, keyName) {
        database.transaction(function (tx) {
            tx.executeSql('CREATE TABLE IF NOT EXISTS ' + table + ' (id INTEGER PRIMARY KEY, sessionId UNIQUE, ' + keyName + ')', [],
                null,
                function (tx, error) {
                    console.log("Error: ", error);
                    console.log("Could not create table ", table);
                }
            );
        });
    }

    // Attempt creation of default tables if not present in DB already
    if (!database) {
        console.log("Database error: Database 'change_history_db' has not been loaded!");
    } else {
        for (var i = 0, len = tables.length; i < len; i++) {
            createTable(tables[i], keyNames[i]);
        }
    }

    // Prints specific row data from table in db
    function printRowContentsDb(table, filePath, keyName) {
        database.transaction(function (tx) {
            tx.executeSql('SELECT * FROM ' + table + ' WHERE sessionId = ?', [filePath], function (tx, results) {
                if (results.rows.length > 0) {
                    // Decode and display data
                    if (keyName === "str__DocTxt") {
                        console.log(He.decode(RawDeflate.inflate(results.rows[0][keyName])));
                    } else {
                        console.log(JSON.parse(He.decode(RawDeflate.inflate(results.rows[0][keyName]))));
                    }
                }
            }, function (tx, error) {
                console.log("Error: Could not print row from table '" + table + "'");
                console.log("Error: ", error);
            });
        });
    }

    // Select and display db contents from all tables by sessionId
    function printSavedContents(filePath) {
        try {
            for (var i = 0, len = tables.length; i < len; i++) {
                printRowContentsDb(tables[i], filePath, keyNames[i]);
            }
        } catch (error) {
            console.log(error);
        }
    }

    // Delete individual row from db
    function delTableRowDb(table, filePath) {
		var result = new $.Deferred();
        database.transaction(function (tx) {
            tx.executeSql('DELETE FROM ' + table + ' WHERE sessionId="' + filePath + '"', [],
            function (tx, txResults) {
				result.resolve();
			},
            function (tx, error) {
                console.log(error);
				result.reject();
            });
        });
    }

    // Select and remove specific rows from db by sessionId
    function delRows(filePath, limitReached) {
        var table,
            result = new $.Deferred();

		try {
			if (limitReached) {
                // Slash and burn all data in db
                filePath = '*';
            }

            for (var i = 0; i < tables.length; i++) {
                table = tables[i];
                delTableRowDb(table, filePath);
            }
            result.resolve();
        } catch (error) {
            console.log(error);
			result.reject();
        }

		return result.promise();
    }

    // Drops a single table from db
    function delTableDb(table) {
        database.transaction(function (tx) {
            tx.executeSql("DROP TABLE " + table, [],
            null,
            function (tx, error) {
                console.log(error);
            });
        });
    };

    // Allow user ability to clear db of accumulated change history
    function wipeAll() {
        try {
            for (var i = 0, len = tables.length; i < len; i++) {
                var table = tables[i];
                delTableDb(table);
            }

        } catch (error) {
            console.log(error);
        }
    }

    // Updates specific row in a table in db    
    function updateTableRowDb(filePath, table, value, keyName) {
		var result = new $.Deferred();

        if (typeof value === "object") {
            value = JSON.stringify(value);
        }

        database.transaction(function (tx) {
            value = value.toString();
            tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
            function (tx, results) {
				result.resolve();
            },
            function (tx, error) {
                console.log(error);

                // Entry already exists--overwrite it via update
                if (error.code === 6) {
                    tx.executeSql('UPDATE ' + table + ' SET ' + keyName + '=? WHERE sessionId="' + filePath + '"', [value],
                    function (tx, results) {
						result.resolve();
                    },
                    function (tx, error) {
                        console.log(error);
						result.reject();
                    });
                }

                // Code #4 means storage capacity reached for table 
                // Must make some room, then try again
                if (error.code === 4) {
                    delRows(null, true)
						.done(function () {
							tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
								function (tx, result) {
									result.resolve();
								},
								function (tx, error) {
									console.log(error);
									result.reject();
								}
							);
						});
                }
            });
        });
		
		return result.promise();
	}

	// Send/update changes to document text in db
    function sendDocText (docTextToSync, filePath) {
        var compressedDocText = RawDeflate.deflate(He.encode(docTextToSync.toString())),
			result = new $.Deferred();
		
		try {
			updateTableRowDb(filePath, "unsaved_doc_changes", compressedDocText, "str__DocTxt")
				.done(function () {
					result.resolve();
				});
		} catch  (error) {
			console.log(error);
			result.reject();
		}
		
		return result.promise();
    };
    
    // Send/update changes in doc related metadata in db  
    var sendChangeHistory = function(cursorPos, scrollPos, historyObjStr, fullFilePath) {
		var values = [],
			encodedHistoryObjStr = RawDeflate.deflate(He.encode(JSON.stringify(historyObjStr))),
			encodedCursorPos = RawDeflate.deflate(He.encode(JSON.stringify(cursorPos))),
            encodedScrollPos = RawDeflate.deflate(He.encode(JSON.stringify(scrollPos))),
            result = new $.Deferred();
      
        values.push(encodedCursorPos);
        values.push(encodedScrollPos);
        values.push(encodedHistoryObjStr);
        
        if (!database) {
            console.log("Database error! No database loaded!");
        } else {
            try {
                
				for (var i = 0; i < 3; i++) {
                    updateTableRowDb(fullFilePath, tables[i], values[i], keyNames[i]);

                    // Data transmission done
					if (i === 2) {
						result.resolve();
					}
				}
            } catch (error) {
                console.log("Database error: ", error);
                result.reject();
            }
        }

        return result.promise();
    };


    // Copies currently closing documents text, history, etc. to db
    function captureUnsavedDocChanges(that) {
        // Extract latest change history data
		var curHistoryObj = that._masterEditor._codeMirror.getHistory(),
			curDocText = that._masterEditor._codeMirror.getValue(),
            fullPathToFile = that.file._path,
            cursorPos = that._masterEditor.getCursorPos(),
            scrollPos = that._masterEditor.getScrollPos(),
            result = new $.Deferred();
		
        try {
			sendChangeHistory(cursorPos, scrollPos, curHistoryObj, fullPathToFile)
				.done(function () {
					sendDocText(curDocText, fullPathToFile)
						.done(function () {
                            // Undo latest push to db:
                            // Document was just undone back to clean state
                            // or has no new changes in editor despite recent keyup event
                            if (!that.isDirty) {
                                // Remove doc change history data
                                delRows(fullPathToFile);
                            }
                            
                            result.resolve();
						});
				});
        } catch (error) {
            console.log(error);
            result.reject();
        }

        return result.promise();
    }

    exports.database = database;
    exports.captureUnsavedDocChanges = captureUnsavedDocChanges;
    exports.sendChangeHistory = sendChangeHistory;
    exports.delRows = delRows;
    exports.debouncedSync = debouncedSync;
    exports.printSavedContents = printSavedContents; 
    exports.sendDocText = sendDocText;
    exports.wipeAll = wipeAll;
});
