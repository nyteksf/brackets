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
  *       WebSQL/SQLite3 1GB Persistence of Unsaved Changes           *
  *                                                                   *
  * ----------------------------------------------------------------- *
  *                          DB Structure:                            *
  *                   Hot Close:     4 * 200MB Tables                 *
  *                   Local History: 1 * 200MB Table                  *
  * ----------------------------------------------------------------- *
  *                                                                   *
  *                             Hot Close                             *
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
  *                            Local History                          *
  *                               Table 5                             *
  *                   +----------------------------+                  *
  *                   |   "local_history_doctxt"   |                  *
  *                   +----------------------------+                  *
  *                   |      str__DocText TEXT     |                  *
  *                   +----------------------------+                  *
  * ----------------------------------------------------------------- *
  *                                                                   *
  *     The db module interacts with the editor while shadowing its   *
  *		assigned codemirror for a given doc in order to preserve any  *
  *		unsaved changes. This module features database config	 	  *
  *		info, and methods for db instantiation and CRUD. There are	  *
  *		four tables created in total amounting to 500MB in total. 	  *
  *		These tables are each respectively named "cursorpos_coords",  *
  *		"scrollpos_coords", "undo_redo_history" and 				  *
  *		"unsaved_doc_changes". There is another table for another     *
  *     feature called "local_history_doctxt".                        *
  *     In order, these tables contain the last	known document        *
  *     information as related to cursor and scroll positioning,      *
  *     as well as the undo/redo history, and document text in        *
  *     the latter two.                                               *  
  *     Change data is stored by full filepath 	                      *
  *		which is used as the sessionId. Keyup events in a focused 	  *
  *		editor are what trigger syncing of all current history 		  *
  *		data to the database in the case of Hot Close. In the         *
  *     case of Local History, up to five automatically saved         *
  *     document backups are stored in the DB, and then each save     *
  *     pops the oldest off the stack and pushes the newest on top.   *
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
        Dialogs = require("widgets/Dialogs"),
        DefaultDialogs = require("widgets/DefaultDialogs"),
        Strings = require("strings"),
        He = require("thirdparty/he");
    
    // Load globally for Local History on client side
        window.Db              = require("editor/Db"),
        window.He              = require("thirdparty/he"),
        window.MainViewManager = require("view/MainViewManager"),
        window.FileUtils       = require("file/FileUtils"),
        window.DocumentCommandHandlers = require("document/LocalHistory__DocumentCommandHandlers"),
        window.DocumentManager = require("document/DocumentManager");

    // Config settings
    var DB_NAME    = 'change_history_db',
        DB_VERSION = '1.0',
        DB_DESC    = 'Features: Hot Close, Local History',
        DB_SIZE_MB = 1000;

    var database   = window.openDatabase(DB_NAME,
                                    DB_VERSION,
                                    DB_DESC,
                                    DB_SIZE_MB * 1024 * 1024);
    
    // Static db references
    var tables = [
            "cursorpos_coords",
            "scrollpos_coords",
            "undo_redo_history",
            "unsaved_doc_changes",
            "local_history_doctxt"
        ],
        keyNames = [
            "int__CursorPos",
            "int__ScrollPos",
            "str__DocHistory",
            "str__DocTxt"
        ];

    // Initialize 'hot close', 'local history' settings
    var HOT_CLOSE     = "hotClose",
        LOCAL_HISTORY = "localHistory";

    PreferencesManager.definePreference(HOT_CLOSE, "boolean", false, {
        description: Strings.DESCRIPTION_HOT_CLOSE
    });
    //PreferencesManager.definePreference(LOCAL_HISTORY, "boolean", true, {
    //    description: Strings.DESCRIPTION_LOCAL_HISTORY
    //});
    var hotClose     = PreferencesManager.get(HOT_CLOSE),
	localHistory = PreferencesManager.get(LOCAL_HISTORY);

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
    // Default constraint on UNIQUE sessionIds
    // Use false for non-unique sessionIds
    function createTable (table, keyName, uniqueId) {
        var sessionId = "sessionId";
        
        if (!uniqueId) {
            // Do NOOP
        } else {
            sessionId += " UNIQUE";
        }
        
        database.transaction(function (tx) {
            tx.executeSql('CREATE TABLE IF NOT EXISTS ' + table + ' (id INTEGER PRIMARY KEY, ' + sessionId + ', ' + keyName + ')',
                [],
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
        if (hotClose) {
            for (var i=0, len=4; i<len; i++) {
                createTable(tables[i], keyNames[i]);
            }
        }

        if (localHistory) {
            createTable(tables[4], "str__DocTxt, str__Timestamp UNIQUE", false);
        }
    }

    // Prints specific row data from table in db
    function printRowContentsDb(table, filePath, keyName) {
        database.transaction(function (tx) {
            tx.executeSql('SELECT * FROM ' + table + ' WHERE sessionId = ?', 
                [filePath], function (tx, results) {
                if (results.rows.length > 0) {
                    // Decode and display data
                    if (keyName === "str__DocTxt") {
                        console.log(He.decode(window.RawDeflate.inflate(results.rows[0][keyName])));
                    } else {
                        console.log(JSON.parse(He.decode(window.RawDeflate.inflate(results.rows[0][keyName]))));
                    }
                }
            }, function (tx, error) {
                console.log("Error: Could not print row from table '" + table + "'");
                console.log("Error: ", error);
            });
        });
    }

    // Select and display db contents from all tables by sessionId
    function printSavedContents(filePath, localHistory) {
        try {
            if (localHistory) {
                    printRowContentsDb(tables[4], filePath, keyNames[3]);
            } else { // Hot Close
                for (var i=0, len=4; i<len; i++) {
                    printRowContentsDb(tables[i], filePath, keyNames[i]);
                }
            }
        } catch (error) {
            console.log(error);
        }
    }

    // Delete individual row from db
    function delTableRowDb(table, filePath, timestamp) {
		var result = new $.Deferred();
        
        if (timestamp) { // Local History
            database.transaction(function (tx) {
                tx.executeSql('DELETE FROM ' + table + ' WHERE sessionId="' + filePath + '" AND str__Timestamp="' + timestamp + '"', 
                    [],
                    function (tx, txResults) {
                        result.resolve();
                    },
                    function (tx, txError) {
                        console.log(txError);
                        result.reject();
                    }
                );
            });
        } else { // Hot Close
            database.transaction(function (tx) {
                tx.executeSql('DELETE FROM ' + table + ' WHERE sessionId="' + filePath + '"', 
                    [],
                    function (tx, txResults) {
                        result.resolve();
                    },
                    function (tx, txError) {
                        console.log(txError);
                        result.reject();
                    }
                );
            });
        }
    }

    // Select and remove all rows from table based on sessionId
    function delRows(filePath, limitReached, localHistory) {
        var table,
            result = new $.Deferred();

		try {
			if (limitReached) {
                // Slash and burn all data in db
                filePath = '*';
            }
            
            if (localHistory) {
                    delTableRowDb(tables[4], filePath);
            } else {
                // Delete content within Hot Close section of DB
                for (var i = 0; i < 4; i++) {
                    table = tables[i];
                    delTableRowDb(table, filePath);
                }
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
    function wipeAll(localHistory) {
        try {
            if (localHistory) { // Clear local history tables only
                delTableDb(tables[4]);
            } else { // Clear Hot Close tables only
                for (var i = 0, len = 4; i<len; i++) {
                    var table = tables[i];
                    delTableDb(table);
                }
            }
        } catch (error) {
            console.log(error);
        }
    }

    // Updates specific row in a table in db    
    function updateTableRowDb(filePath, table, value, keyName, value2) {
		var result = new $.Deferred();

        if (typeof value === "object") {
            value = JSON.stringify(value);
        }
        
        if (value2) {
            // Presence of second value means Local History updating on file save
            database.transaction(function (tx) {
                value  = value.toString();
                value2 = value2.toString();
                    
                tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '", str__Timestamp) VALUES ("' + filePath + '", ?, ?)', 
                    [value, value2],
                    function (tx, results) {
                        result.resolve();
                    },
                    function (tx, error) {
                        // Error code #4 indicates storage capacity reached for currently used table 
                        // Make some room for new data, then try again when done
                        if (error.code === 4) {
                            delRows(null, true, true)
                                .done(function () {
                                    tx.executeSql('INSERT INTO local_history_doctxt (sessionId, str__DocTxt, str__Timestamp) VALUES ("' + filePath + '", ?, ?)',
                                        [value, value2],
                                        function (tx, result) {
                                            result.resolve();
                                        },
                                        function (tx, error) {
                                            result.reject();
                                        }
                                    );
                                });  // Log any other error to the console
                        } 
                        else if (error.code !== 6) {
                            console.log(error);
                        }
                    });
                });
            } else {
                // Handle Hot Close update
                database.transaction(function (tx) {
                    value = value.toString();
                    tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
                        function (tx, results) {
                            result.resolve();
                        },
                        function (tx, error) {
                            // Error code #4 indicates storage capacity reached for currently used table 
                            // Make some room for new data, then try again when done
                            if (error.code === 4) {
                                delRows(null, true)
                                    .done(function () {
                                        tx.executeSql('INSERT INTO ' + table + ' (sessionId, "' + keyName + '") VALUES ("' + filePath + '", ?)', [value],
                                            function (tx, result) {
                                                result.resolve();
                                            },
                                            function (tx, error) {
                                                result.reject();
                                            }
                                        );
                                    });
                            // Error code #6, due to SQL constraints, indicates an entry already exists in a given row
                            // Overwrite the row via Update
                            } 
                            else if (error.code === 6) {
                                tx.executeSql('UPDATE ' + table + ' SET ' + keyName + '=? WHERE sessionId="' + filePath + '"', [value],
                                function (tx, results) {
                                    result.resolve();
                                },
                                function (tx, error) {
                                    result.reject();
                                });
                            } else { console.log(error); }
                        });
            });
        }
		
		return result.promise();
	}
    
	// Send/update changes to document text in db
    function sendDocText(docTextToSync, filePath, fileTimestamp) {
        var compressedDocText = window.RawDeflate.deflate(He.encode(docTextToSync.toString())),
			result = new $.Deferred();
		
		try {
            if (fileTimestamp) {
                // If timestamp present, handle Local History back-up
                updateTableRowDb(filePath, "local_history_doctxt", compressedDocText, "str__DocTxt", fileTimestamp);
                
            } else {
                // Handle document hot close
                updateTableRowDb(filePath, "unsaved_doc_changes", compressedDocText, "str__DocTxt")
				.done(function () {
					result.resolve();
				});
                
            }
		} catch  (error) {
			console.log(error);
			result.reject();
		}
		
		return result.promise();
    };
    
    // Send/update changes in doc related metadata in db  
    var sendChangeHistory = function(cursorPos, scrollPos, historyObjStr, fullFilePath) {
		var values = [],
			encodedHistoryObjStr = window.RawDeflate.deflate(He.encode(JSON.stringify(historyObjStr))),
			encodedCursorPos = window.RawDeflate.deflate(He.encode(JSON.stringify(cursorPos))),
            encodedScrollPos = window.RawDeflate.deflate(He.encode(JSON.stringify(scrollPos))),
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
    
    /*
     * Confirm deletion of individual Local History table row item
     */
    function confirmDeleteDocDialog() {
        Dialogs.showModalDialog(
            DefaultDialogs.DIALOG_ID_LOCAL_HISTORY,
            Strings.LOCAL_HISTORY_TITLE,
            Strings.LOCAL_HISTORY_DEL_CONFIRM_MESSAGE,
            [
                {
                    className : Dialogs.DIALOG_BTN_CLASS_PRIMARY,
                    id        : Dialogs.DIALOG_BTN_OK,
                    text      : Strings.OK
                }
            ]
        )
            .done(function(id) {
                if (id === Dialogs.DIALOG_BTN_OK) {
                    setTimeout(function() {
                        $(".modal-footer").find(".btn.primary").attr("disabled", "disabled");
                    }, 250);   
                }
            });
    }
    
    /*
     * Prompt for deletion of individual documents from Local History DB table
     */
    function deleteDocPromptDialog(pathToCurFile, timestamp) {
        setTimeout(function(){
            $(".modal-footer").find(".btn.primary").removeAttr("disabled");
        }, 250);

        Dialogs.showModalDialog(
            DefaultDialogs.DIALOG_ID_LOCAL_HISTORY,
            Strings.LOCAL_HISTORY_TITLE,
            Strings.LOCAL_HISTORY_DEL_PROMPT_MESSAGE,
            [
                {
                    className : Dialogs.DIALOG_BTN_CLASS_NORMAL,
                    id        : Dialogs.DIALOG_BTN_CANCEL,
                    text      : Strings.CANCEL
                },
                {
                    className : Dialogs.DIALOG_BTN_CLASS_PRIMARY,
                    id        : Dialogs.DIALOG_BTN_DELETE,
                    text      : Strings.DELETE
                }
            ]
        )
            .done(function(id2) {
                var $eachLi = $(document).find(".LHListItem");
                $eachLi.removeClass("activeLHModalLi");
                
                if (id2 === Dialogs.DIALOG_BTN_DELETE) {
                    console.log("PROCEEDING WITH DELETION")
                    setTimeout(function() {
                        $(".modal-footer").find(".btn.primary").removeAttr("disabled");
                    }, 250);
                    
                    delTableRowDb("local_history_doctxt", pathToCurFile, timestamp);
                    confirmDeleteDocDialog();
                } else { 
                    console.log("CANCEL")  
                    $eachLi.show();
                            
                }
            });   
    }
    
    // For use with Local History dialog file list
    window.deleteDocPromptDialog = deleteDocPromptDialog;
    
    exports.database = database;
    exports.captureUnsavedDocChanges = captureUnsavedDocChanges;
    exports.sendChangeHistory = sendChangeHistory;
    exports.delRows = delRows;
    exports.delTableRowDb = delTableRowDb;
    exports.debouncedSync = debouncedSync;
    exports.printSavedContents = printSavedContents; 
    exports.sendDocText = sendDocText;
    exports.wipeAll = wipeAll;
});
