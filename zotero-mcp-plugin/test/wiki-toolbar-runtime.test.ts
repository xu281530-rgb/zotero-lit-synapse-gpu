/* global assert, describe, it, after, before */

describe("Wiki toolbar runtime", function () {
  let win: _ZoteroTypes.MainWindow;
  let openedTabID: string | undefined;

  before(function () {
    win = Zotero.getMainWindow() as _ZoteroTypes.MainWindow;
  });

  after(function () {
    if (openedTabID && openedTabID !== "zotero-pane") {
      win.Zotero_Tabs.close(openedTabID);
    }
  });

  it("uses the configured enlarged toolbar size", function () {
    const button = win.document.getElementById(
      "zotero-mcp-wiki-button",
    ) as XUL.ToolbarButton;
    assert.exists(button);

    const buttonBounds = button.getBoundingClientRect();
    const iconBounds = button.icon.getBoundingClientRect();
    assert.closeTo(buttonBounds.width, 36, 1);
    assert.closeTo(buttonBounds.height, 36, 1);
    assert.closeTo(iconBounds.width, 30, 1);
    assert.closeTo(iconBounds.height, 30, 1);
  });

  it("selects and displays the Wiki tab when clicked", async function () {
    const button = win.document.getElementById(
      "zotero-mcp-wiki-button",
    ) as XUL.ToolbarButton;
    assert.exists(button);

    assert.throws(() => {
      win.Zotero_Tabs.add({
        type: "zotero-mcp-wiki",
        title: "损坏的旧 Wiki 标签",
        select: false,
      });
    }, /tab\.data is undefined|property ["']icon["']/u);

    button.dispatchEvent(
      new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );

    openedTabID = win.Zotero_Tabs.selectedID;
    assert.notEqual(openedTabID, "zotero-pane");
    assert.equal(win.Zotero_Tabs.selectedType, "zotero-mcp-wiki");

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (win.document.getElementById("zotero-mcp-wiki-panel")) break;
      await Zotero.Promise.delay(100);
    }
    assert.equal(
      win.document.getElementById("zotero-mcp-wiki-panel")?.parentElement?.id,
      openedTabID,
    );
    assert.isFalse(
      (win.Zotero_Tabs as any)._tabs.some(
        (tab: any) => tab.type === "zotero-mcp-wiki" && tab.data === undefined,
      ),
    );
  });
});
