// Command-line watch-list management (the portal does the same).
//   npm run items -- list             show the watch list
//   npm run items -- add <url> [name] add an item
//   npm run items -- remove <itemNumber>
import { loadConfig } from "./config";
import { ItemRepository, type Item } from "./store/items";

const label = (item: Item) => item.name || `item ${item.itemNumber}`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const repo = new ItemRepository(cfg.itemsPath);

  switch (cmd) {
    case "list": {
      const items = await repo.list();
      if (items.length === 0) console.log("The watch list is empty.");
      for (const i of items) console.log(`${i.itemNumber.padEnd(12)} ${label(i)}\n${"".padEnd(12)} ${i.url}`);
      return;
    }
    case "add": {
      const [url, ...name] = args;
      if (!url) throw new Error("usage: npm run items -- add <costco product url> [name]");
      const item = await repo.add({ url, name: name.join(" ") });
      console.log(
        item.name
          ? `Added ${item.name} (${item.itemNumber}).`
          : `Added item ${item.itemNumber}. Its name is filled in from the page on the first check.`,
      );
      return;
    }
    case "remove": {
      if (!args[0]) throw new Error("usage: npm run items -- remove <itemNumber>");
      const item = await repo.remove(args[0]);
      console.log(`Removed ${label(item)} (${item.itemNumber}).`);
      return;
    }
    default:
      console.log("usage: npm run items -- list | add <url> [name] | remove <itemNumber>");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e: Error) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
