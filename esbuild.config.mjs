import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "browser",
  target: ["es2019"],
  sourcemap: true
};

async function build() {
  await esbuild.build({
    ...shared,
    entryPoints: ["code.ts"],
    outfile: "dist/code.js"
  });

}

async function watch() {
  const ctxMain = await esbuild.context({
    ...shared,
    entryPoints: ["code.ts"],
    outfile: "dist/code.js"
  });
  await ctxMain.watch();

  console.log("Watching…");
}

if (isWatch) {
  await watch();
} else {
  await build();
}