// @flow
import R from 'ramda';
import Component from '../component';
import { Component as ModelComponent } from '../../scope/models';
import { Consumer } from '..';
import { sha1 } from '../../utils';
import { SourceFile } from '../component/sources';
import { Tmp } from '../../scope/repositories';
import mergeFiles from './merge-files';

export type MergeResults = {
  addFiles: string[],
  modifiedFiles: Array<{
    filePath: string,
    fsFile: SourceFile,
    baseFile: SourceFile,
    currentFile: SourceFile,
    output: ?string,
    conflict: ?string
  }>,
  unModifiedFiles: string[],
  overrideFiles: string[],
  hasConflicts: boolean
};

/**
 * it's easier to understand with an example.
 * a component bar/foo has two versions: 0.0.1, 0.0.2. Also, the component was modified locally.
 * the user is running 'bit use 0.0.1 bar/foo' to switch the version of bar/foo to 0.0.1.
 *
 * the goal is to rewrite bar/foo to the filesystem as 0.0.1 and keeping the local changes.
 * in other words, the changes the user did since 0.0.2 should be applied/merged on top of 0.0.1.
 *
 * to do the actual merge we use git, specifically `merge-file` command, so we try to use the same
 * language as git. From the command help:
 * `git merge-file <current-file> <base-file> <other-file>
 * git merge-file incorporates all changes that lead from the <base-file> to <other-file> into
 * <current-file>. The result ordinarily goes into <current-file>.`
 *
 * according to the example above:
 * current-file => bar/foo@0.0.1
 * base-file    => bar/foo@0.0.2
 * other-file   => bar/foo@0.0.2 + modification
 */
export default (async function mergeVersions({
  consumer,
  componentFromFS,
  modelComponent,
  fsVersion,
  currentVersion
}: {
  consumer: Consumer,
  componentFromFS: Component,
  modelComponent: ModelComponent,
  fsVersion: string,
  currentVersion: string
}): Promise<MergeResults> {
  const baseComponent: Component = await modelComponent.toConsumerComponent(
    fsVersion,
    consumer.scope.name,
    consumer.scope.objects
  );
  const currentComponent: Component = await modelComponent.toConsumerComponent(
    currentVersion,
    consumer.scope.name,
    consumer.scope.objects
  );

  const fsFiles = componentFromFS.files;
  const baseFiles = baseComponent.files;
  const currentFiles = currentComponent.files;

  const results = { addFiles: [], modifiedFiles: [], unModifiedFiles: [], overrideFiles: [], hasConflicts: false };
  const getFileResult = (fsFile: SourceFile, baseFile?: SourceFile, currentFile?: SourceFile) => {
    const filePath = fsFile.relative;
    if (!currentFile || !baseFile) {
      // if !currentFile && !baseFile, the file was created after the last tag
      // if !currentFile && baseFile,  the file was created as part of the last tag
      // if currentFile && !baseFile,  the file was deleted as part of the last tag
      // either way, no need to do any calculation, the file should be added
      results.addFiles.push(filePath);
      return;
    }
    const fsFileHash = sha1(fsFile.contents);
    const baseFileHash = sha1(baseFile.contents);
    const currentFileHash = sha1(currentFile.contents);
    if (fsFileHash === currentFileHash) {
      // no need to check also for fsFileHash === baseFileHash, as long as fs == current, no need to take any action
      results.unModifiedFiles.push(filePath);
      return;
    }
    if (fsFileHash === baseFileHash) {
      results.overrideFiles.push(fsFile);
    }
    // it was changed in both, there is a chance for conflict
    results.modifiedFiles.push({ filePath, fsFile, baseFile, currentFile, output: null, conflict: null });
  };

  fsFiles.forEach((fsFile) => {
    const relativePath = fsFile.relative;
    const baseFile = baseFiles.find(file => file.relative === relativePath);
    const currentFile = currentFiles.find(file => file.relative === relativePath);
    getFileResult(fsFile, baseFile, currentFile);
  });

  if (R.isEmpty(results.modifiedFiles)) return results;

  const conflictResults = await getConflictResults(consumer, results.modifiedFiles);
  conflictResults.forEach((conflictResult) => {
    const modifiedFile = results.modifiedFiles.find(file => file.filePath === conflictResult.filePath);
    if (!modifiedFile) throw new Error(`unable to find ${conflictResult.filePath} in modified files array`);
    modifiedFile.output = conflictResult.output;
    modifiedFile.conflict = conflictResult.conflict;
    if (conflictResult.conflict) results.hasConflicts = true;
  });

  return results;
});

async function getConflictResults(consumer: Consumer, modifiedFiles): Promise<Array<any>> {
  const tmp = new Tmp(consumer.scope);
  const conflictResultsP = modifiedFiles.map(async (modifiedFile) => {
    const fsFilePath = await tmp.save(modifiedFile.fsFile.contents);
    const baseFilePath = await tmp.save(modifiedFile.baseFile.contents);
    const currentFilePath = await tmp.save(modifiedFile.currentFile.contents);
    return mergeFiles(modifiedFile.filePath, currentFilePath, baseFilePath, fsFilePath);
  });
  try {
    const conflictResults = await Promise.all(conflictResultsP);
    await tmp.clear();
    return conflictResults;
  } catch (err) {
    await tmp.clear();
    throw err;
  }
}