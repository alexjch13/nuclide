'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

// eslint-disable-next-line nuclide-internal/no-cross-atom-imports
import {BusySignalProviderBase} from '../../nuclide-busy-signal';
import {ArcanistDiagnosticsProvider} from '../lib/ArcanistDiagnosticsProvider';
import nuclideUri from '../../commons-node/nuclideUri';
import {generateFixture} from '../../nuclide-test-helpers';
import {Range} from 'atom';

describe('ArcanistDiagnosticsProvider', () => {
  let provider: ArcanistDiagnosticsProvider = (null: any);
  let tempFile: string = (null: any);

  beforeEach(() => {
    waitsForPromise(async () => {
      const folder = await generateFixture('arcanist_diagnostic_provider', new Map([
        ['test', 'abc'],
      ]));
      tempFile = nuclideUri.join(folder, 'test');
      provider = new ArcanistDiagnosticsProvider(new BusySignalProviderBase());
    });
  });

  it('should invalidate the messages when a file is closed', () => {
    spyOn(provider._providerBase, 'publishMessageInvalidation');
    waitsForPromise(async () => {
      const editor = await atom.workspace.open(tempFile);

      // The editor path may get changed (empiracally, prefixed with 'private/'),
      // so we 'getPath()' here.
      const filePath = editor.getPath();

      // We have to destroy panes themselves, not merely the pane items, in order
      // to trigger the callbacks that ArcanistDiagnosticsProvider registers on
      // atom.workspace.onWillDestroyPaneItem.
      const theOnlyPane = atom.workspace.getPanes()[0];
      theOnlyPane.destroy();

      expect(provider._providerBase.publishMessageInvalidation).toHaveBeenCalledWith({
        scope: 'file',
        filePaths: [filePath],
      });
    });
  });

  it('should not invalidate the messages when there are multiple buffers with the file', () => {
    spyOn(provider._providerBase, 'publishMessageInvalidation');
    waitsForPromise(async () => {
      await atom.workspace.open(tempFile);
      // Open a second pane, containing a second editor with the same file.
      const paneToSplit = atom.workspace.getPanes()[0];
      paneToSplit.splitLeft({copyActiveItem: true});

      // We have to destroy panes themselves, not merely the pane items, in order
      // to trigger the callbacks that ArcanistDiagnosticsProvider registers on
      // atom.workspace.onWillDestroyPaneItem.
      paneToSplit.destroy();
      expect(provider._providerBase.publishMessageInvalidation).not.toHaveBeenCalled();
    });
  });

  describe('_getRangeForFix', () => {
    it('should work for single-line fixes', () => {
      const range = provider._getRangeForFix(3, 4, 'asdf');
      expect(range).toEqual(new Range([3, 4], [3, 8]));
    });

    it('should work for multi-line fixes', () => {
      const range = provider._getRangeForFix(3, 4, '\nasdf\njdjdj\n');
      expect(range).toEqual(new Range([3, 4], [6, 0]));
    });
  });

  describe('_getFix', () => {
    it('should return the fix', () => {
      const fix = provider._getFix({
        row: 1,
        col: 3,
        original: 'foo',
        replacement: 'bar',
      });
      expect(fix).toEqual({
        oldRange: new Range([1, 3], [1, 6]),
        oldText: 'foo',
        newText: 'bar',
      });
    });

    it('should truncate a common suffix', () => {
      const fix = provider._getFix({
        row: 1,
        col: 3,
        original: 'foobar',
        replacement: 'fbar',
      });
      expect(fix).toEqual({
        oldRange: new Range([1, 3], [1, 6]),
        oldText: 'foo',
        newText: 'f',
      });
    });
  });
});
