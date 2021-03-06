// @flow

import semver from 'semver';
import inquirer from 'inquirer';
import { mainStory, chalk } from 'storyboard';
import { readAllSpecs, ROOT_PACKAGE } from './utils/readSpecs';
import writeSpecs from './utils/writeSpecs';
import { exec } from './utils/shell';
import {
  gitLastTag,
  gitCurBranch,
  gitUncommittedChanges,
  gitUnpulledChanges,
  gitDiffSinceIn,
  gitCommitChanges,
  gitAddTag,
  gitPushWithTags,
} from './utils/git';
import { addVersionLine } from './utils/changelog';

const DEBUG_SKIP_CHECKS = false;
const RELEASE_INCREMENTS = ['major', 'minor', 'patch'];
const PRERELEASE_INCREMENTS = ['rc', 'beta', 'alpha'];
const INCREMENTS = [...RELEASE_INCREMENTS, ...PRERELEASE_INCREMENTS];

type Options = {
  src: string,
  ignoreSrc?: string,
  incrementVersionBy?: string,
  master: boolean,
  checkUncommitted: boolean,
  checkUnpulled: boolean,
  checks: boolean,
  confirm: boolean,
  gitCommit: boolean,
  newVersion?: string,
  npmPublish: boolean,
  publishTag?: string,
  changelog: boolean,
  changelogPath: string,
  single: boolean,
  // For unit tests
  _date?: ?Object, // overrides the current date
  _masterVersion?: string, // overrides the current master version
};

const run = async ({
  src,
  ignoreSrc,
  master,
  checkUncommitted,
  checkUnpulled,
  checks,
  confirm,
  gitCommit,
  newVersion,
  npmPublish,
  publishTag,
  incrementVersionBy,
  changelog,
  changelogPath,
  single,
  _date,
  _masterVersion,
}: Options) => {

  // @todo - check to see if this command is being run with `yarn`

  const allSpecs = await readAllSpecs(src, ignoreSrc);
  const pkgNames = Object.keys(allSpecs).filter(x => !allSpecs[x].specs.private)

  // Confirm that we have run build
  if (confirm) {
    const { confirmBuild } = await inquirer.prompt([
      {
        name: 'confirmBuild',
        type: 'confirm',
        message: 'Have you built all your packages for production?',
        default: false,
      },
    ]);
    if (!confirmBuild) return;
  }
  // Prepublish checks
  if (checks) {
    await prepublishChecks({ master, checkUncommitted, checkUnpulled });
  }

  // Get last tag and find packages requiring updates
  const lastTag = await gitLastTag();
  // const dirty = await findPackagesToUpdate(allSpecs, lastTag, single);
  // if (!dirty.length) {
  //   mainStory.info('No packages have been updated');
  //   return;
  // }

  // Determine a suitable version number
  const masterVersion =
    _masterVersion || (await getMasterVersion(allSpecs, lastTag));
  if (masterVersion == null) return;
  if (incrementVersionBy) {
    if (INCREMENTS.indexOf(incrementVersionBy) < 0) {
      mainStory.error(
        `Value specified for --increment-version-by: ${chalk.bold(
          incrementVersionBy
        )} is invalid.`
      );
      mainStory.error(
        `It should be one of (${INCREMENTS.join(', ')}), or not specified.`
      );
      if (!DEBUG_SKIP_CHECKS) throw new Error('INVALID_INCREMENT_BY_VALUE');
    }
  }
  const nextVersion =
    newVersion ||
    calcNextVersion(masterVersion, incrementVersionBy) ||
    (await promptNextVersion(masterVersion));

  // Confirm before proceeding
  if (confirm) {
    const { confirmPublish } = await inquirer.prompt([
      {
        name: 'confirmPublish',
        type: 'confirm',
        message:
          `Confirm release (${chalk.yellow.bold(pkgNames.length)} package/s, ` +
          `v${chalk.cyan.bold(nextVersion)})?${pkgNames.map(x => `\n• ${x}`).join('')}\n`,
        default: false,
      },
    ]);
    if (!confirmPublish) return;
  }

  const { specPath: rootSpecPath, specs: rootSpecs } = allSpecs[ROOT_PACKAGE]
  rootSpecs.version = nextVersion
  writeSpecs(rootSpecPath, rootSpecs);

  
  // Commit...
  if (gitCommit) {
    await gitCommitChanges(`"chore: v${nextVersion}"`);
  }

  if (changelog) {
    await exec('npm -s run changelog')
    await gitCommitChanges(`"docs: Updated changelog for v${nextVersion}"`)
    addVersionLine({ changelogPath, version: nextVersion, _date });
  }

  // Tag and push
  if (gitCommit) {
    await gitAddTag(`v${nextVersion}`);
    await gitPushWithTags();
  }

  // Update package.json versions + cross-linked dependency versions
  for (const pkgA of pkgNames) {
    const { specPath: specPathA, specs: specsA } = allSpecs[pkgA];
    mainStory.info(`Updating`, `${pkgA} ${specsA.version} -> ${nextVersion}`)
    specsA.version = nextVersion;
    if (!specsA.dependencies || specsA.private) continue
    for (const pkgB of pkgNames) {
      const { specPath: specPathB, specs: specsB } = allSpecs[pkgA];
      if (specsA.dependencies[pkgB]) {
        specsA.dependencies[pkgB] = nextVersion
      }
    }
    writeSpecs(specPathA, specsA);
  }


  // Publish
  if (npmPublish) {
    for (const pkgName of pkgNames) {
      const { pkgPath, specs } = allSpecs[pkgName];
      if (specs.private) continue; // we don't want npm to complain :)
      // const cmd = 'npm pack'
      let cmd = 'npm publish --access public';
      if (publishTag != null) cmd += ` --tag ${publishTag}`;
      await exec(cmd, { cwd: pkgPath });
    }
  }
};

// ------------------------------------------------
// Helpers
// ------------------------------------------------
const prepublishChecks = async ({
  master,
  checkUncommitted,
  checkUnpulled,
}) => {
  if (DEBUG_SKIP_CHECKS) {
    mainStory.warn('DEBUG_SKIP_CHECKS should be disabled!!');
  }

  // Check current branch
  const branch = await gitCurBranch();
  if (branch !== 'master') {
    if (master) {
      mainStory.error(
        `Can't publish from current branch: ${chalk.bold(branch)}`
      );
      if (!DEBUG_SKIP_CHECKS) throw new Error('BRANCH_CHECK_FAILED');
    }
    mainStory.warn(
      `Publishing from a non-master branch: ${chalk.red.bold(branch)}`
    );
  } else {
    mainStory.info(`Current branch: ${chalk.yellow.bold(branch)}`);
  }

  // Check that the branch is clean
  const uncommitted = await gitUncommittedChanges();
  if (uncommitted !== '') {
    if (checkUncommitted) {
      mainStory.error(
        `Can't publish with uncommitted changes (stash/commit them): \n${chalk.bold(
          uncommitted
        )}`
      );
      if (!DEBUG_SKIP_CHECKS) throw new Error('UNCOMMITTED_CHECK_FAILED');
    }
    mainStory.warn('Publishing with uncommitted changes');
  } else {
    mainStory.info('No uncommitted changes');
  }

  // Check remote history
  const unpulled = await gitUnpulledChanges();
  if (unpulled !== '0') {
    if (checkUnpulled) {
      mainStory.error('Remote history differs. Please pull changes');
      if (!DEBUG_SKIP_CHECKS) throw new Error('UNPULLED_CHECK_FAILED');
    }
    mainStory.warn('Publishing with unpulled changes');
  } else {
    mainStory.info('Remote history matches local history');
  }
};

const findPackagesToUpdate = async (allSpecs, lastTag, single) => {
  const pkgNames = Object.keys(allSpecs);
  const dirty = [];
  for (let i = 0; i < pkgNames.length; i++) {
    const pkgName = pkgNames[i];
    if (pkgName === ROOT_PACKAGE && !single) continue;
    const { pkgPath, specs } = allSpecs[pkgName];
    if (specs.private) continue;
    const diff = await gitDiffSinceIn(lastTag, pkgPath);
    if (diff !== '') {
      const numChanges = diff.split('\n').length;
      mainStory.info(
        `- Package ${pkgName} (currently ${chalk.cyan.bold(
          specs.version
        )}) has changed (#files: ${numChanges})`
      );
      dirty.push(pkgName);
    }
  }
  return dirty;
};

const getMasterVersion = async (allSpecs, lastTag) => {
  let masterVersion = allSpecs[ROOT_PACKAGE].specs.version;
  if (lastTag != null) {
    const tagVersion = semver.clean(lastTag);
    mainStory.info(`Last tag found: ${chalk.yellow.bold(lastTag)}`);
    if (tagVersion !== masterVersion) {
      mainStory.warn(
        `Last tagged version ${chalk.cyan.bold(
          tagVersion
        )} does not match package.json version ${chalk.cyan.bold(
          masterVersion
        )}`
      );
      mainStory.warn(
        'This may cause inaccuracies when determining which packages ' +
          'need to be released, since oao uses tags to detect package changes'
      );
      const { confirm } = await inquirer.prompt([
        {
          name: 'confirm',
          type: 'confirm',
          message: 'Continue?',
          default: false,
        },
      ]);
      if (!confirm) return null;
      if (semver.valid(tagVersion) && semver.gt(tagVersion, masterVersion)) {
        masterVersion = tagVersion;
      }
      mainStory.warn(
        `Using ${chalk.cyan.bold(
          masterVersion
        )} as reference (the highest one of both)`
      );
    }
  } else {
    mainStory.warn('Repo has no tags yet');
  }
  if (!semver.valid(masterVersion)) {
    mainStory.error(
      `Master version ${chalk.cyan.bold(
        masterVersion
      )} is invalid. Please correct it manually`
    );
    throw new Error('INVALID_VERSION');
  }
  return masterVersion;
};

const calcNextVersion = (prevVersion: string, incrementBy = ''): string => {
  const isPreRelease = PRERELEASE_INCREMENTS.indexOf(incrementBy) >= 0;
  const increment = isPreRelease ? 'prerelease' : incrementBy;
  const isNewPreRelease = isPreRelease && prevVersion.indexOf(incrementBy) < 0;
  return isNewPreRelease
    ? `${semver.inc(prevVersion, 'major')}-${incrementBy}.0`
    : semver.inc(prevVersion, increment);
};

const promptNextVersion = async (prevVersion: string): Promise<string> => {
  const major = semver.inc(prevVersion, 'major');
  const minor = semver.inc(prevVersion, 'minor');
  const patch = semver.inc(prevVersion, 'patch');
  const prerelease = semver.inc(prevVersion, 'prerelease');
  const rc = prevVersion.indexOf('rc') < 0 ? `${major}-rc.0` : prerelease;
  const beta = prevVersion.indexOf('beta') < 0 ? `${major}-beta.0` : prerelease;
  const alpha =
    prevVersion.indexOf('alpha') < 0 ? `${major}-alpha.0` : prerelease;
  const { nextVersion } = await inquirer.prompt([
    {
      name: 'nextVersion',
      type: 'list',
      message: `Current version is ${chalk.cyan.bold(prevVersion)}. Next one?`,
      choices: [
        { name: `Major (${chalk.cyan.bold(major)})`, value: major },
        { name: `Minor (${chalk.cyan.bold(minor)})`, value: minor },
        { name: `Patch (${chalk.cyan.bold(patch)})`, value: patch },
        { name: `Release candidate (${chalk.cyan.bold(rc)})`, value: rc },
        { name: `Beta (${chalk.cyan.bold(beta)})`, value: beta },
        { name: `Alpha (${chalk.cyan.bold(alpha)})`, value: alpha },
      ],
      defaultValue: 2,
    },
  ]);
  return nextVersion;
};

// ------------------------------------------------
// Public
// ------------------------------------------------
export default run;
