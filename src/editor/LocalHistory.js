/*
 * Copyright (c) 2014 - present Adobe Systems Incorporated. All rights reserved.
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

define(function (require, exports, module) {
    'use strict';

    var DocumentCommandHandlers = require("document/LocalHistory__DocumentCommandHandlers"),
        DocumentManager = require("document/DocumentManager"),
        Dialogs         = require("widgets/Dialogs"),
        DefaultDialogs  = require("widgets/DefaultDialogs"),
        Strings         = require("strings"),
        StringUtils     = require("utils/StringUtils"),
        EditorManager   = require("editor/EditorManager"),
        MainViewManager = require("view/MainViewManager"),
        CommandManager  = require("command/CommandManager"),
        Commands        = require("command/Commands"),
        He              = require("thirdparty/he"),
        Db              = require("editor/Db"),
        ThemeManager = brackets.getModule("view/ThemeManager"),
        FileUtils       = require("file/FileUtils");

    // Local History related methods for use on the client side
    // Condensed from:-
    //    -MainViewManager.js
    //    -DocumentCommandHandlers.js
    //    -FileUtils.js
    //    -DocumentManager.js

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
                // Remove darker blue active class from currently active <li>
                var $eachLi = $(window.document).find(".LHListItem");
                $eachLi.removeClass("activeLHModalLi");

                if (id2 === Dialogs.DIALOG_BTN_DELETE) {
                    setTimeout(function() {
                        $(".modal-footer").find(".btn.primary").removeAttr("disabled");
                    }, 250);

                    Db.delTableRowDb("local_history_doctxt", pathToCurFile, timestamp);
                    confirmDeleteDocDialog();
                } else {
                    $(".lastClickedXClose").parent().show();
                    setTimeout(function() {
                        $(window.document).find(".dialog-button.btn.primary").prop("disabled", "disabled");
                    }, 250);
                }
            });
    }

    // Local History UI: handle active item click
    function whenClickListItem(that) {
        $(window.document).find(".dialog-button.btn.primary").removeAttr("disabled");
        $(window.document).find(".dialog-button.btn.primary").off("click");
        $(window.document).find(".dialog-button.btn.primary").on("click", function() {
            var activeLi = $(".localHistoryContainer").find(".activeLHModalLi");
            var timestamp = activeLi[0].attributes[2].value;
            var pathToOpenFile = window.LocalHistory.MainViewManager.getCurrentlyViewedPath("first-pane"),
                doc = window.LocalHistory.DocumentManager.getOpenDocumentForPath(pathToOpenFile);
                
            window.LocalHistory.Db.database.transaction(function(tx) {
                tx.executeSql("SELECT str__DocTxt FROM local_history_doctxt WHERE str__Timestamp = ? AND sessionId = ?",
                    [timestamp, pathToOpenFile], 
                    function(tx, results) {
                        var savedDocTextToLoad = window.LocalHistory.He.decode(window.RawDeflate.inflate(results.rows[0].str__DocTxt));

                        if (doc.isDirty) {
                            window.LocalHistory.DocumentCommandHandlers.handleFileSave({
                                doc: doc,
                                savedDocText: savedDocTextToLoad
                            });
                        } else {
                            doc._masterEditor._codeMirror.setValue(savedDocTextToLoad);
                            doc._masterEditor._codeMirror.refresh();
                            doc._masterEditor._codeMirror.clearHistory(); 

                            window.LocalHistory.FileUtils.writeText(doc.file, savedDocTextToLoad, true)
                                .done(function() {
                                    doc.notifySaved();
                                });
                        }
                    }, 
                    function(tx, error) {
                        console.log(error);
                    }
                );
            });
        });
        
        $(".localHistoryContainer li").removeClass("activeLHModalLi");
        $(that).addClass("activeLHModalLi");
    }
    
    // Local History UI: handle x-close click
    function handleItemClose(that) {
        var $thisLi = $(that).parent(),
            timestamp = $(that).parent().attr("timestamp"),
            pathToCurFile = window.LocalHistory.MainViewManager.getCurrentlyViewedPath("first-pane");
        
        window.LocalHistory.deleteDocPromptDialog(pathToCurFile, timestamp);
        $thisLi.hide();
        $thisLi.removeClass("lightLiActive darkLiActive activeLHModalLi");
        $(".LHListItemXClose").removeClass("lastClickedXClose");
        $(that).addClass("lastClickedXClose");
    }
    
    function setUIColors(currentTheme) {
        var $body = $('body');
        
        EditorManager.checkForOpenDialog(function() {
            // Find all associated UI elements in DOM
            var $localHistoryContainer = $body.find(".localHistoryContainer"),
                $LhContainerUl = $body.find(".localHistoryContainer ul"),
                $listItems = $body.find(".LHListItem");
            console.log(currentTheme)            
            // Adjust Local History UI theme to match master theme of Brackets
            if (currentTheme === "light-theme") {
                // Setting class for LI Container (Parent)
                $localHistoryContainer.addClass("LHContainerLight");
                            
                // Setting class for LI Container (Child)
                $LhContainerUl.addClass("LhUlLight");
                            
                // Setting class for active LI
                $listItems
                    .on("click", function() {
                        $listItems.removeClass("lightLiActive");    
                        $(this).addClass("lightLiActive");
                    });

                // Setting class for inactive List Items
                $listItems.addClass("LHListItemLight");

                // Setting class for LI hover effects
                $listItems
                    .on("mouseover", function() {
                    $listItems.removeClass("LHListItemLightHover");
                    $(this).addClass("LHListItemLightHover");
                });
                $listItems
                    .on("mouseout", function() {
                    $(this).removeClass("LHListItemLightHover");
                });
            } 
            else if (currentTheme === "dark-theme") {
                $localHistoryContainer.addClass("LHContainerDark");
                $LhContainerUl.addClass("LhUlDark");
                $listItems.addClass("LHListItemDark");
                $listItems
                    .on("click", function() {
                        $listItems.removeClass("darkLiActive");
                        $listItems.removeClass("LHListItemDarkSwapWhenActive");
                        $listItems.addClass("LHListItemDark");
                        $(this).removeClass("LHListItemDark");
                        $(this).addClass("LHListItemDarkSwapBeforeActive");
                        $(this).addClass("darkLiActive");
                    });
                $listItems
                    .on("mouseover", function() {
                        $listItems.removeClass("LHListItemDarkHover");
                        $(this).addClass("LHListItemDarkHover");
                    });
                $listItems
                    .on("mouseout", function() {
                        $(this).removeClass("LHListItemDarkHover");
                    });
            }
        });
    };

    // For use with Local History dialog file list on client side
    exports.setUIColors              = setUIColors;
    exports.deleteDocPromptDialog    = deleteDocPromptDialog;
    exports.whenClickListItem        = whenClickListItem;
    exports.handleItemClose          = handleItemClose;
    exports.MainViewManager          = MainViewManager;  /* <-getCurrentlyViewedPath() */
    exports.DocumentCommandHandlers  = DocumentCommandHandlers; /* <-.handleFileSave() */
    exports.FileUtils       = FileUtils;  /* <-.writeText() */
    exports.DocumentManager = DocumentManager; /* <-.getOpenDocumentForPath() */
    exports.He              = He;  /* <-.decode() */
    exports.Db              = Db;  /* <-.database.transaction() */
});
