import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

const appRoot = process.argv[2];
if (!appRoot) throw new Error("Usage: node scripts/check-oceanofpdf-native-contract.mjs /path/to/BooksApp (requires Swift on macOS)");
const root = await mkdtemp(path.join(tmpdir(), "ocean-native-contract-"));
try {
  const taskPath = path.join(root, "task.json");
  const context = vm.createContext({ URL, Date, pagev2: async task => {
    await writeFile(taskPath, JSON.stringify(task));
    return { evaluatedData: { url: task.url, items: [], next: null } };
  } });
  vm.runInContext(await readFile(new URL("../modules/oceanofpdf/index.js", import.meta.url), "utf8"), context);
  await context.SynthetiqModule.discoveryHome();
  const executable = path.join(root, "proof");
  execFileSync("swiftc", [path.join(appRoot, "Sources/SynthetiqMangaCore/ModuleRuntimeContracts.swift"),
    fileURLToPath(new URL("../tests/oceanofpdf-page-task-proof.swift", import.meta.url)), "-o", executable],
    { stdio: "inherit", timeout: 60000 });
  execFileSync(executable, [taskPath], { stdio: "inherit", timeout: 10000 });
} finally {
  await rm(root, { recursive: true, force: true });
}
