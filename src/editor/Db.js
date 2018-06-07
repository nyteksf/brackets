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

  /*******************************************************\
  *                                                       *
  * WebSQL/SQLite3 500 MB Persistence of Unsaved Changes  *
  *                                                       *
  * ----------------------------------------------------- *
  *                    125MB x 4 Tables                   *
  * ----------------------------------------------------- *
  *                                                       *
  *           Table 1                  Table 2            *
  *  +------------------------+------------------------+  *
  *  |   'cursorpos_coords'   |   'scrollpos_coords'   |  *
  *  +------------------------+------------------------+  *
  *  | int__CursorPos INTEGER | int__ScrollPos INTEGER |  *
  *  +------------------------+------------------------+  *
  *                                                       *
  *           Table 3                  Table 4            *
  *  +------------------------+------------------------+  *
  *  |  'undo_redo_history'   | 'unsaved_doc_changes'  |  *
  *  +------------------------+------------------------+  *
  *  |  str__DocHistory TEXT  |    str__DocTxt TEXT    |  *
  *  +------------------------+------------------------+  *
  *                                                       *
  * ----------------------------------------------------- *
  *                                                       *
  *     This module features db config info, db           *
  *     instantiation and associated CRUD methods         *
  *                                                       *
  \*******************************************************/
define(function (require, exports, module) {
    'use strict';

    var PreferencesManager = require("preferences/PreferencesManager"),
    	Strings = require("strings"),
    	CompressionUtils = require("thirdparty/rawdeflate"),
        CompressionUtils = require("thirdparty/rawinflate"),
        He = require("thirdparty/he");

    // Db config
    var HOT_CLOSE = "hotClose";

    PreferencesManager.definePreference(HOT_CLOSE, "boolean", true, {
        description: Strings.DESCRIPTION_HOT_CLOSE
    });

    var hotClose = PreferencesManager.get(HOT_CLOSE);

    var DB_NAME    = 'change_history_db',
        DB_VERSION = '1.0',
        DB_DESC    = 'Feature: Hot Close',
        DB_SIZE_MB = 300;
        
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
    function debouncedDbSync(delay, arg) {
        return function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                captureUnsavedDocChanges(arg);
            }, delay || 1250);
        };
    };

    // Generate individual db table
    function generateTable (table, keyName) {
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
            generateTable(tables[i], keyNames[i]);
        }
    }

    // Prints specific row data from table in db    
    function printRowContentsDb(table, filePath, keyName) {
        database.transaction(function (tx) {
            tx.executeSql('SELECT * FROM ' + table + ' WHERE sessionId = ?', [filePath], function (tx, results) {
                if (keyName === "str__DocTxt") {
                    console.log(He.decode(RawDeflate.inflate(results.rows[0][keyName])));
                } else {
                    console.log(results.rows[0][keyName]);
                }
            }, function (tx, error) {
                console.log("Error: Could not print row from table '" + table + "'.");
                console.log("Error: ", error);
            });
        });
    }

    // Display db contents by sessionId in console
    function printContentsDb(filePath) {
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

    // Remove specific rows from db by sessionId
    function delRowsDb(filePath, limitReached) {
        try {
            if (limitReached) {
                // Wipe all data from db
                filePath = '*';
            }
            
            var table;
            for (var i = 0; i < tables.length; i++) {
                table = tables[i];
                delTableRowDb(table, filePath);
            }
            
        } catch (err) {
            console.log(err);
        }
    }

    // Delete a single table from db
    function delTableDb(table) {
        database.transaction(function (tx) {
            tx.executeSql("DROP TABLE " + table, [],
            null,
            function (tx, error) {
                console.log(error);
            });
        })
    };

    // Allow user ability to clear db of accumulated change history
    function wipeAllDb() {
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
        if (typeof value === "object") {
            value = JSON.stringify(value);
        }

        database.transaction(function (tx) {
            value = value.toString();
            tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
            null,
            function (tx, error) {
                // Entry already exists--overwrite it via update
                if (error.code === 6) {
                    tx.executeSql('UPDATE ' + table + ' SET ' + keyName + '=? WHERE sessionId="' + filePath + '"', [value],
                    null,
                    function (tx, error) {
                        console.log(error);
                    });
                }

                // Storage capacity reached for table--make some room, try again
                if (error.code === 4) {
                    delRowsDb(null, true);

                    tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
                    null,
                    function (tx, error) {
                        console.log(error);
                    }
                    )
                }
            })
        })
    }

    // This is the 'Save Change Data to DB' function
    var sendChangeHistoryDb = function(cursorPos, scrollPos, curHistoryObjStr, currentTxtDeflated, fullFilePath) {
        var values = [
            cursorPos,
            scrollPos,
            curHistoryObjStr,
            currentTxtDeflated
        ];
        
        if (!database) {
            console.log("Database error! No database loaded!");
        } else {
            try {
                for (var i = 0; i < 4; i++) {
                    updateTableRowDb(fullFilePath, tables[i], values[i], keyNames[i]);
                }
            } catch (err) {
                console.log("Database error! ", err);
            }
        }
    }

    // Stashes a copy of the current document text, history, etc. in db
    function captureUnsavedDocChanges(that) {
        // Extract latest change history
        var curRawTxtObj = He.encode(JSON.stringify(that._codeMirror.getHistory())),
            currentTextObj = RawDeflate.deflate(curRawTxtObj),
            currentTxt = that._codeMirror.getValue(),
            fullPathToFile = that.document.file._path,
            cursorPos = that.getCursorPos(),
            scrollPos = that.getScrollPos(),
            docTxtSpecialCharsEncoded = He.encode(currentTxt),
            curTxtDeflated = RawDeflate.deflate(docTxtSpecialCharsEncoded),
            result = new $.Deferred(),
            promise = result.promise();
        try {
            sendChangeHistoryDb(cursorPos, scrollPos, currentTextObj, curTxtDeflated, fullPathToFile);
        } catch (err) {
            console.log(err);
        }
        result.reject();
        
        return promise;
    }

    exports.database = database;
    exports.captureUnsavedDocChanges = captureUnsavedDocChanges;
    exports.sendChangeHistoryDb = sendChangeHistoryDb;
    exports.delRowsDb = delRowsDb;
})