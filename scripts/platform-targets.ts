export interface PlatformTarget {
  key: string;
  packageName: string;
  packageManifestPath: string;
  binaryName: string;
  packageBinaryPath: string;
  bunTarget: string;
  buildOutputPath: string;
  os: readonly string[];
  cpu: readonly string[];
}

export const PLATFORM_TARGETS: PlatformTarget[] = [
  {
    key: "darwin-arm64",
    packageName: "@samuelfaj/distill-darwin-arm64",
    packageManifestPath: "packages/distill-darwin-arm64/package.json",
    binaryName: "distill",
    packageBinaryPath: "packages/distill-darwin-arm64/bin/distill",
    bunTarget: "bun-darwin-arm64",
    buildOutputPath: ".dist/bun-darwin-arm64/distill",
    os: ["darwin"],
    cpu: ["arm64"]
  },
  {
    key: "darwin-x64",
    packageName: "@samuelfaj/distill-darwin-x64",
    packageManifestPath: "packages/distill-darwin-x64/package.json",
    binaryName: "distill",
    packageBinaryPath: "packages/distill-darwin-x64/bin/distill",
    bunTarget: "bun-darwin-x64",
    buildOutputPath: ".dist/bun-darwin-x64/distill",
    os: ["darwin"],
    cpu: ["x64"]
  },
  {
    key: "linux-arm64",
    packageName: "@samuelfaj/distill-linux-arm64",
    packageManifestPath: "packages/distill-linux-arm64/package.json",
    binaryName: "distill",
    packageBinaryPath: "packages/distill-linux-arm64/bin/distill",
    bunTarget: "bun-linux-arm64",
    buildOutputPath: ".dist/bun-linux-arm64/distill",
    os: ["linux"],
    cpu: ["arm64"]
  },
  {
    key: "linux-x64",
    packageName: "@samuelfaj/distill-linux-x64",
    packageManifestPath: "packages/distill-linux-x64/package.json",
    binaryName: "distill",
    packageBinaryPath: "packages/distill-linux-x64/bin/distill",
    bunTarget: "bun-linux-x64",
    buildOutputPath: ".dist/bun-linux-x64/distill",
    os: ["linux"],
    cpu: ["x64"]
  },
  {
    key: "win32-x64",
    packageName: "@samuelfaj/distill-win32-x64",
    packageManifestPath: "packages/distill-win32-x64/package.json",
    binaryName: "distill.exe",
    packageBinaryPath: "packages/distill-win32-x64/bin/distill.exe",
    bunTarget: "bun-windows-x64",
    buildOutputPath: ".dist/bun-windows-x64/distill.exe",
    os: ["win32"],
    cpu: ["x64"]
  }
];

export function getCurrentPlatformKey(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  return `${platform}-${arch}`;
}

export function getPlatformTarget(key: string): PlatformTarget | undefined {
  return PLATFORM_TARGETS.find((target) => target.key === key);
}

export function selectPlatformTargets(options?: {
  buildAll?: boolean;
  platform?: string;
  arch?: string;
}): PlatformTarget[] {
  if (options?.buildAll) {
    return PLATFORM_TARGETS;
  }

  const key = getCurrentPlatformKey(options?.platform, options?.arch);
  const target = getPlatformTarget(key);
  return target ? [target] : [];
}
