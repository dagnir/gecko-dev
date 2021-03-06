/* Any copyright", " is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests that a node's tagname can be edited in the markup-view

waitForExplicitFinish();

const TEST_URL = "data:text/html,<div id='retag-me'><div id='retag-me-2'></div></div>";

function test() {
  Task.spawn(function() {
    info("Opening the inspector on the test page");
    let {toolbox, inspector} = yield addTab(TEST_URL).then(openInspector);

    yield inspector.markup.expandAll();

    info("Selecting the test node");
    let node = content.document.getElementById("retag-me");
    let child = content.document.querySelector("#retag-me-2");
    yield selectNode(node, inspector);

    let container = getContainerForRawNode(inspector.markup, node);
    is(node.tagName, "DIV", "We've got #retag-me element, it's a DIV");
    ok(container.expanded, "It is expanded");
    is(child.parentNode, node, "Child #retag-me-2 is inside #retag-me");

    info("Changing the tagname");
    let mutated = inspector.once("markupmutation");
    let tagEditor = container.editor.tag;
    setEditableFieldValue(tagEditor, "p", inspector);
    yield mutated;

    info("Checking that the tagname change was done");
    let node = content.document.getElementById("retag-me");
    let container = getContainerForRawNode(inspector.markup, node);
    is(node.tagName, "P", "We've got #retag-me, it should now be a P");
    ok(container.expanded, "It is still expanded");
    ok(container.selected, "It is still selected");
    is(child.parentNode, node, "Child #retag-me-2 is still inside #retag-me");

    gBrowser.removeCurrentTab();
  }).then(null, ok.bind(null, false)).then(finish);
}
