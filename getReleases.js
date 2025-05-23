import { Buffer } from 'buffer';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import TOML from 'smol-toml';

/**
 * Get the Git tags of the specified repository that denote a Lean release.
 *
 * Note that some repositories, such as Mathlib, do not make GitHub releases for these Git tags,
 * so we use Git instead of GitHub to access this data.
 *
 * @param repo: repository in the OWNER/REPO format. Use null for the current project.
 */
function getVersionTags(repo) {
  var versionTags;
  if (repo !== null) {
    console.log(`Fetching tags from ${repo}`);
    const cmd = `git ls-remote --tags https://github.com/${repo}.git`;
    versionTags = execSync(cmd, { encoding: 'utf8' })
      .split('\n')
      // Lines with a ^{} indicate an "annotated tag": these appear twice in the list of tags, once with and once without ^{}.
      .filter(line => line !== null && !line.endsWith('^{}'))
      // Each line holds information on a tag, of the format '${commitHash} refs/tags/${tagName}'.
      // We want only the tags of the format `v${major}.${minor}(.${patch})`.
      .map(line => {
        const match = line.match(/refs\/tags\/(v.*\..*)$/);
        if (match != null) {
          return match[1];
        } else {
          return null;
        }})
      .filter(tag => tag !== null);
  } else {
    console.log(`Fetching release tags from current repository.`);
    const cmd = `git tag --list 'v*.*'`;
    versionTags = execSync(cmd, { encoding: 'utf8' })
      .split('\n')
      .filter(line => line !== '');
  }

  // Parse version tags as semver (removing the 'v' prefix)
  const semvers = versionTags
    .map(ver => {
      const parts = ver.substring(1).split('.');
      // FIXME: parse version suffixes e.g. `-rc${n}`.
      return {
        major: parseInt(parts[0]),
        minor: parseInt(parts[1]),
        patch: parseInt(parts[2] || 0),
        original: ver
      };
    });

  // Sort versions and get the latest one
  semvers.sort((a, b) => {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
  });

  return semvers;
}

function fileChanges(filename) {
  const diff = execSync(`git diff -w ${filename}`, { encoding: 'utf8' });
  return diff.length > 0;
}

/**
 * Modify the project's `lakefile.lean` so it depends on Mathlib at the specified tag.
 */
function modifyLakefileLeanMathlibVersion(fd, tag) {
  throw new Error('Project uses `lakefile.lean`; this is not yet supported!');
}

/**
 * Modify the project's `lakefile.toml` so it depends on Mathlib at the specified tag.
 */
function modifyLakefileTOMLMathlibVersion(fd, tag) {
  const data = fs.readFileSync(fd, 'utf8');
  const lakefile = TOML.parse(data);
  console.log(lakefile);

  for (const pkg of lakefile.require) {
    if (pkg.scope == 'leanprover-community' && pkg.name == 'mathlib') {
      pkg.rev = tag;
    }
  }
  console.log(lakefile);

  // Overwrite the file.
  // First truncate the file, to handle the case where the new file is shorter.
  fs.ftruncateSync(fd);
  // Explicitly set the writing position to 0, since it will have been moved by reading.
  const buffer = Buffer.from(TOML.stringify(lakefile), 'utf8');
  fs.writeSync(fd, buffer, undefined, undefined, 0);
}

/**
 * Modify the project's Lakefile so it depends on Mathlib at the specified tag.
 */
function modifyLakefileMathlibVersion(tag) {
  // Lake prefers `.lean` over `.toml` files.
  // So, we try opening the `.lean` file, but if that fails, we try again with the `.toml`.
  // Use try/catch instead of `if (fs.access('lakefile.lean'))` to avoid TOCTOU issues.
  try {
    const fd = fs.openSync('lakefile.lean', 'r+');
    return modifyLakefileLeanMathlibVersion(fd, tag);
  } catch (error) { 
    console.log("Could not open `lakefile.lean`: trying again with `lakefile.toml`.")
  }
  try {
    const fd = fs.openSync('lakefile.toml', 'r+');
    return modifyLakefileTOMLMathlibVersion(fd, tag);
  } catch (error) {
    throw new Error(`Could not find \`lakefile.lean\` or \`lakefile.toml\`.\nNote: nested error: ${error}.\nHint: make sure the \`lake_package_directory\` input is set to a directory containing a lakefile.`);
  }
}

function lakeUpdate(legacyUpdate) {
  if (legacyUpdate) {
    console.log('Using legacy update command');
    execSync('lake -R -Kenv=dev update', { stdio: 'inherit' });
  } else {
    console.log('Using standard update command');
    execSync('lake update', { stdio: 'inherit' });
  }
}

function ensureLabelExists(labelName) {
  const labelNames = JSON.parse(execSync('gh label list --json name')).map(label => label.name);
  if (!labelNames.includes(labelName)) {
    console.log(`Creating issue label ${labelName}`);
    execSync(`gh label create "${labelName}"`);
  }
}

function createCommit(tag, prevPR) {
  const toolchainChanges = fileChanges('lean-toolchain');
  const manifestChanges = fileChanges('lake-manifest.json');
  if (!toolchainChanges && !manifestChanges) {
    console.log('No changes to commit - skipping update.');
    return null;
  }
  const branchName = `auto-update-mathlib/patch-${tag}`;
  var body = '';
  if (toolchainChanges) {
    const newToolchain = fs.readFileSync('lean-toolchain', 'utf8');
    body += `
The \`lean-toolchain\` file has been updated to the following version:
\`\`\`
${newToolchain}
\`\`\``;
  }
  if (prevPR !== null) {
    body += `\n\nDepends on: ${prevPR}`;
  }

  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
  execSync(`git commit -m "Update to mathlib@${tag}" -- lean-toolchain lake-manifest.json`, { stdio: 'inherit' });
  execSync(`git push origin HEAD:refs/heads/${branchName}`, { stdio: 'inherit' });
  const prURL = execSync(`gh pr create --head "${branchName}" --title "Updates available and ready to merge" --label "auto-update-lean" --body-file -`, { input: body });
  return prURL;
}

/**
 * Create a pull request for each new Lean release tag in Mathlib.
 */
try {
  const legacyUpdate = process.env.LEGACY_UPDATE === 'true';

  const mathlibReleases = getVersionTags('leanprover-community/mathlib4');
  const ourReleases = getVersionTags(null);
  console.log(`Found ${mathlibReleases.length} Mathlib releases and ${ourReleases.length} project releases.`);

  // If this project has no versions released yet, only upgrade to the latest Mathlib master.
  // Otherwise we'd get a PR upgrading to each Mathlib version in turn.
  // (If you install a `lean-release-action` workflow, the release tag should have been automatically created.)
  var newReleases = [];
  if (ourReleases.length > 0) {
    // If this project does have some releases already, do not skip any intermediate steps,
    // upgrade to each release in turn from the last one that we support.
    const latestVersion = ourReleases[ourReleases.length - 1];
    newReleases = mathlibReleases.filter(v => {
      if (v.major > latestVersion.major) return true;
      if (v.minor > latestVersion.minor) return true;
      return v.patch > latestVersion.patch;
    });
  }

  console.log(`Going to upgrade to the versions: ${JSON.stringify(newReleases)}, followed by 'master'.`);

  ensureLabelExists('auto-update-lean');

  var lastPR = null;
  for (const release of newReleases) {
    modifyLakefileMathlibVersion(release.original);
    lakeUpdate(legacyUpdate);
    const nextPR = createCommit(release.original, lastPR);
    if (nextPR !== null) {
      lastPR = nextPR;
    }
  }

  modifyLakefileMathlibVersion('master');
  lakeUpdate(legacyUpdate);
  createCommit('master', lastPR);
} catch (error) {
  console.error('Error updating Lean version:', error.message);
  process.exit(1);
}
