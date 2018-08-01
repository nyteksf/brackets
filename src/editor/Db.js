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
  *		and document text. Keyup events trigger the syncing of all	  *
  *		current history data to the database.		 				  *
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
    var HOT_CLOSE = "hotClose";

    PreferencesManager.definePreference(HOT_CLOSE, "boolean", true, {
        description: Strings.DESCRIPTION_HOT_CLOSE
    });

    var hotClose = PreferencesManager.get(HOT_CLOSE);

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
		} catch (err) {
			console.log(err);
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
        console.log("Database error! Database 'change_history_db' has not been loaded!");
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
                    if (keyName === "str__DocTxt") {
                        console.log(He.decode(RawDeflate.inflate(results.rows[0][keyName])));
                    } else {
                        console.log(results.rows[0][keyName]);
                    }
                } else { console.log("NOTHING TO PRINT: ROWS FOR FILE ARE EMPTY") }
            }, function (tx, error) {
                console.log("Error: Could not print row from table '" + table + "'.");
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
        } catch (err) {
            console.log(err);
        }
    }

    // Delete individual row from db
    function delTableRowDb(table, filePath) {
        database.transaction(function (tx) {
            tx.executeSql('DELETE FROM ' + table + ' WHERE sessionId="' + filePath + '"', [],
            null,
            function (tx, error) {
                console.log(error);
            });
        });
    }

    // Select and remove specific rows from db by sessionId
    function delRows(filePath, limitReached) {
        var result = new $.Deferred();
		
		try {
			if (limitReached) {
                // Slash and burn all data in db
                filePath = '*';
            }
            
            var table;
            for (var i = 0; i < tables.length; i++) {
                table = tables[i];
                delTableRowDb(table, filePath);
            }
            result.resolve();	
        } catch (err) {
            console.log(err);
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
            
        } catch (err) {
            console.log(err);
        }
    }

    // Updates specific row in a table in db    
    function updateTableRowDb(filePath, table, value, keyName) {
        console.log("INSERTING DATA NOW...")
        if (typeof value === "object") {
            value = JSON.stringify(value);
        }

        database.transaction(function (tx) {
            value = value.toString();
            tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
            function (tx, results) {
                console.log("INSERTED DATA INTO TABLE ", table);
            },
            function (tx, error) {
                console.log(error);
                
                // Entry already exists--overwrite it via update
                if (error.code === 6) {
                    tx.executeSql('UPDATE ' + table + ' SET ' + keyName + '=? WHERE sessionId="' + filePath + '"', [value],
                    function (tx, results) {
                        console.log("UPDATED TABLE " + table + " WITH NEW DATA")
                    },
                    function (tx, error) {
                        console.log(error);
                    });
                }

                // Storage capacity reached for table--make some room, try again
                if (error.code === 4) {
                    delRows(null, true);

                    tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
                    null,
                    function (tx, error) {
                        console.log(error);
                    }
                    );
                }
            });
        });
    }

    function sendDocText (filePath, docTextToSync) {
        var compressedDocText = docTextToSync.toString(),
			result = new $.Deferred();
		
		try {
			updateTableRowDb(filePath, "unsaved_doc_changes", docTextToSync, "str__DocTxt");
			result.resolve();
		} catch  (err) {
			console.log(err);
			result.reject();
		}
		
		return result.promise();
    };
    
    // This is the 'Save Change Data to DB' function
    var sendChangeHistory = function(cursorPos, scrollPos, curHistoryObjStr, fullFilePath) {
        
        var values = [
            cursorPos,
            scrollPos,
            curHistoryObjStr
        ],
            result = new $.Deferred();
        
        if (!database) {
            console.log("Database error! No database loaded!");
        } else {
            try {
                for (var i = 0; i < 3; i++) {
                    updateTableRowDb(fullFilePath, tables[i], values[i], keyNames[i]);
                }
                result.resolve();
                console.log("finished iterating through change data")
            } catch (err) {
                console.log("Database error! ", err);
                result.reject();
            }
        }
        
        return result.promise();
    };

    // Copies currently closing documents text, history, etc. to db
    function captureUnsavedDocChanges(that) {
        // Extract latest change history data        
        var curHistoryObj = RawDeflate.deflate(He.encode(JSON.stringify(that._masterEditor._codeMirror.getHistory()))),
			curDocText = RawDeflate.deflate(He.encode(that._masterEditor._codeMirror.getValue())),
            fullPathToFile = that.file._path,
            cursorPos = that._masterEditor.getCursorPos(),
            scrollPos = that._masterEditor.getScrollPos(),
            result = new $.Deferred();
        
        try {
			sendChangeHistory(cursorPos, scrollPos, curHistoryObj, fullPathToFile)
				.then(function () {
					sendDocText(fullPathToFile, curDocText)
						.then(function () {
							console.log("DONE UPDATING TABLES");
							result.resolve();
						});
				});
        } catch (err) {
            console.log(err);
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
