'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {NuclideUri} from '../../commons-node/nuclideUri';
import type {CommitModeType, DiffModeType, UIProvider} from './types';
import type {DiffEntityOptions} from './DiffViewModel';
import type FileTreeContextMenu from '../../nuclide-file-tree/lib/FileTreeContextMenu';
import type {HomeFragments} from '../../nuclide-home/lib/types';
import type {CwdApi} from '../../nuclide-current-working-directory/lib/CwdApi';
import type {GetToolBar} from '../../commons-atom/suda-tool-bar';

import type {RegisterNux, TriggerNux} from '../../nuclide-nux/lib/main';

import {CompositeDisposable, Disposable} from 'atom';
import createPackage from '../../commons-atom/createPackage';
import {React, ReactDOM} from 'react-for-atom';
import url from 'url';
import uiTreePath from '../../commons-atom/ui-tree-path';
import {repositoryForPath, getHgRepositoryStream} from '../../nuclide-hg-git-bridge';
import {DiffMode, CommitMode} from './constants';
import DiffViewElement from './DiffViewElement';
import DiffViewComponent from './DiffViewComponent';
import DiffViewModel from './DiffViewModel';
import {track} from '../../nuclide-analytics';
import {createDiffViewNux, NUX_DIFF_VIEW_ID} from './diffViewNux';

// Redux store
import type {Store} from './types';
import typeof * as BoundActionCreators from './redux/Actions';

import {createEmptyAppState} from './redux/createEmptyAppState';
import * as Actions from './redux/Actions';
import * as Epics from './redux/Epics';
import * as Reducers from './redux/Reducers';
import {applyMiddleware, bindActionCreators, createStore} from 'redux';
import {combineEpics, createEpicMiddleware} from '../../commons-node/redux-observable';
import {Observable} from 'rxjs';
import UniversalDisposable from '../../commons-node/UniversalDisposable';
import {getLogger} from '../../nuclide-logging';
import featureConfig from '../../commons-atom/featureConfig';

type SerializedDiffViewState = {
  visible: false,
} | {
  visible: true,
  activeFilePath: NuclideUri,
  viewMode: DiffModeType,
  commitMode: CommitModeType,
};

// This url style is the one Atom uses for the welcome and settings pages.
const NUCLIDE_DIFF_VIEW_URI = 'atom://nuclide/diff-view';
const DIFF_VIEW_FILE_TREE_CONTEXT_MENU_PRIORITY = 1000;
const COMMIT_FILE_TREE_CONTEXT_MENU_PRIORITY = 1100;
const AMEND_FILE_TREE_CONTEXT_MENU_PRIORITY = 1200;
const PUBLISH_FILE_TREE_CONTEXT_MENU_PRIORITY = 1300;

function formatDiffViewUrl(diffEntityOptions_?: ?DiffEntityOptions): string {
  let diffEntityOptions = diffEntityOptions_;
  if (diffEntityOptions == null) {
    diffEntityOptions = {file: ''};
  }
  return url.format({
    protocol: 'atom',
    host: 'nuclide',
    pathname: 'diff-view',
    slashes: true,
    query: diffEntityOptions,
  });
}

function diffActivePath(diffOptions?: Object): void {
  const editor = atom.workspace.getActiveTextEditor();
  if (editor == null) {
    atom.workspace.open(formatDiffViewUrl(diffOptions));
  } else {
    atom.workspace.open(formatDiffViewUrl({
      file: editor.getPath() || '',
      ...diffOptions,
    }));
  }
}

function isActiveEditorDiffable(): boolean {
  const editor = atom.workspace.getActiveTextEditor();
  if (editor == null) {
    return false;
  }
  return isPathDiffable(editor.getPath());
}

function shouldDisplayDiffTreeItem(contextMenu: FileTreeContextMenu): boolean {
  const node = contextMenu.getSingleSelectedNode();
  return node != null && isPathDiffable(node.uri);
}

function isPathDiffable(filePath: ?string): boolean {
  if (filePath == null || filePath.length === 0) {
    return false;
  }
  const repository = repositoryForPath(filePath);
  return repository != null && repository.getType() === 'hg';
}

// Listen for file tree context menu file item events to open the diff view.
function addFileTreeCommands(
  commandName: string,
  diffOptions?: Object,
): IDisposable {
  const subscriptions = new CompositeDisposable();
  subscriptions.add(atom.commands.add(
    '.tree-view .entry.file.list-item',
    commandName,
    event => {
      const filePath = uiTreePath(event);
      atom.workspace.open(formatDiffViewUrl({
        file: filePath || '',
        ...diffOptions,
      }));
    },
  ));

  subscriptions.add(atom.commands.add(
    '.tree-view .entry.directory.list-nested-item > .list-item',
    commandName,
    event => {
      const directoryPath = uiTreePath(event);
      atom.workspace.open(formatDiffViewUrl({
        directory: directoryPath || '',
        ...diffOptions,
      }));
    },
  ));
  return subscriptions;
}

function addActivePathCommands(
  commandName: string,
  diffOptions?: Object,
): IDisposable {
  const subscriptions = new CompositeDisposable();

  function onTargetCommand(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    diffActivePath(diffOptions);
  }

  subscriptions.add(atom.commands.add(
    'atom-workspace',
    commandName,
    onTargetCommand,
  ));
  // Listen for in-editor context menu item diff view open command.
  subscriptions.add(atom.commands.add(
    'atom-text-editor',
    commandName,
    onTargetCommand,
  ));
  return subscriptions;
}

class Activation {

  _subscriptions: UniversalDisposable;
  _cwdApi: ?CwdApi;
  _diffViewModel: ?DiffViewModel;
  _diffViewElement: ?DiffViewElement;
  _diffViewComponent: ?React.Component<DiffViewComponent, any, any>;
  _tryTriggerNuxService: ?TriggerNux;
  _uiProviders: Array<UIProvider>;

  _store: Store;
  _actionCreators: BoundActionCreators;

  constructor(rawState: ?SerializedDiffViewState) {
    this._uiProviders = [];
    this._subscriptions = new UniversalDisposable();

    const initialState = createEmptyAppState();

    const epics = Object.keys(Epics)
     .map(k => Epics[k])
     .filter(epic => typeof epic === 'function');
    const rootEpic = (actions, store) => (
      combineEpics(...epics)(actions, store)
        // Log errors and continue.
        .catch((err, stream) => {
          getLogger().error(err);
          return stream;
        })
    );

    this._store = createStore(
     Reducers.app,
     initialState,
     applyMiddleware(createEpicMiddleware(rootEpic)),
    );
    const states = Observable.from(this._store);
    this._actionCreators = bindActionCreators(Actions, this._store.dispatch);

    const useReduxStore: boolean = (featureConfig.get('nuclide-diff-view.useReduxStore'): any);
    if (useReduxStore) {
      this._subscriptions.add(
        // TODO(most): use action creators and consume states.
        states.subscribe(state => getLogger().info('diff-view-state', state)),
        getHgRepositoryStream().subscribe(repository => {
          this._actionCreators.addRepository(repository);
          // TODO(most): Only activate the repository when the diff view is open
          // and has that repository selected.
          this._actionCreators.activateRepository(repository);
        }),
      );
    }

    this._subscriptions.add(
      // Listen for menu item workspace diff view open command.
      addActivePathCommands('nuclide-diff-view:open'),
      addActivePathCommands('nuclide-diff-view:commit', {
        viewMode: DiffMode.COMMIT_MODE,
        commitMode: CommitMode.COMMIT,
      }),
      addActivePathCommands('nuclide-diff-view:amend', {
        viewMode: DiffMode.COMMIT_MODE,
        commitMode: CommitMode.AMEND,
      }),
      addActivePathCommands('nuclide-diff-view:publish', {
        viewMode: DiffMode.PUBLISH_MODE,
      }),

      // Context Menu Items.
      atom.contextMenu.add({
        'atom-text-editor': [
          {type: 'separator'},
          {
            label: 'Source Control',
            submenu: [
              {
                label: 'Open in Diff View',
                command: 'nuclide-diff-view:open',
              },
              {
                label: 'Commit',
                command: 'nuclide-diff-view:commit',
              },
              {
                label: 'Amend',
                command: 'nuclide-diff-view:amend',
              },
              {
                label: 'Publish to Phabricator',
                command: 'nuclide-diff-view:publish',
              },
            ],
            shouldDisplay() {
              return isActiveEditorDiffable();
            },
          },
          {type: 'separator'},
        ],
      }),

      // Listen for switching to editor mode for the active file.
      atom.commands.add(
        'nuclide-diff-view',
        'nuclide-diff-view:switch-to-editor',
        () => {
          const {filePath} = this._getDiffViewModel().getState();
          if (filePath != null && filePath.length) {
            atom.workspace.open(filePath);
          }
        },
      ),

      addFileTreeCommands('nuclide-diff-view:open-context'),
      addFileTreeCommands('nuclide-diff-view:commit-context', {
        viewMode: DiffMode.COMMIT_MODE,
        commitMode: CommitMode.COMMIT,
      }),
      addFileTreeCommands('nuclide-diff-view:amend-context', {
        viewMode: DiffMode.COMMIT_MODE,
        commitMode: CommitMode.AMEND,
      }),
      addFileTreeCommands('nuclide-diff-view:publish-context', {
        viewMode: DiffMode.PUBLISH_MODE,
      }),

      // The Diff View will open its main UI in a tab, like Atom's preferences and welcome pages.
      atom.workspace.addOpener(uri => {
        if (uri.startsWith(NUCLIDE_DIFF_VIEW_URI)) {
          if (!require('semver').gte(atom.getVersion(), '1.6.1')) {
            throw new Error(
              'Outdated Atom version<br/>\n' +
              '**Nuclide\'s Diff View require Atom 1.6.1 or later**',
            );
          }
          const {query: diffEntityOptions} = url.parse(uri, true);
          return this._getDiffViewElement(
            (diffEntityOptions: any),
          );
        }
      }),
    );

    if (rawState == null || !rawState.visible) {
      return;
    }

    const {activeFilePath, viewMode, commitMode} = rawState;

    // Wait for the source control providers to be ready:
    const restorationSubscriptions = new CompositeDisposable(
      // If it's a local directory, or if "nuclide-hg-repository" was activated
      // after "nuclide-diff-view":
      atom.packages.serviceHub.consume('atom.repository-provider', '^0.1.0', () => {
        tryRestoreActiveDiffView();
      }),
      // If it's a remote directory, it should come on a path change event:
      atom.project.onDidChangePaths(() => {
        tryRestoreActiveDiffView();
      }),
    );
    this._subscriptions.add(restorationSubscriptions);

    const tryRestoreActiveDiffView = () => {
      // If there is no repository ready, it may be because it's a remote file,
      // or because "nuclide-hg-repository" hasn't loaded yet.
      const canRestoreActiveDiffView = activeFilePath ?
        isPathDiffable(activeFilePath) :
        atom.project.getDirectories().some(directory => {
          return isPathDiffable(directory.getPath());
        });
      if (canRestoreActiveDiffView) {
        restorationSubscriptions.dispose();
        this._subscriptions.remove(restorationSubscriptions);
        atom.workspace.open(formatDiffViewUrl({
          file: activeFilePath,
          viewMode,
          commitMode,
        }));
      }
    };
  }

  _getDiffViewModel(): DiffViewModel {
    let diffViewModel = this._diffViewModel;
    if (diffViewModel == null) {
      diffViewModel = new DiffViewModel();
      diffViewModel.setUiProviders(this._uiProviders);
      this._subscriptions.add(diffViewModel);
      this._diffViewModel = diffViewModel;
    }
    return diffViewModel;
  }

  // To add a View as an Atom workspace pane, we return `DiffViewElement` extending `HTMLElement`.
  // This pattern is also followed with atom's TextEditor.
  _getDiffViewElement(diffEntityOptions: DiffEntityOptions): DiffViewElement {
    if (this._diffViewElement != null) {
      const diffViewElement = this._diffViewElement;
      this._activateDiffPath(diffEntityOptions);
      return diffViewElement;
    }

    const diffModel = this._getDiffViewModel();
    diffModel.activate();
    const hostElement = this._diffViewElement = new DiffViewElement()
      .initialize(diffModel, NUCLIDE_DIFF_VIEW_URI);
    this._diffViewComponent = ReactDOM.render(
      <DiffViewComponent
        diffModel={diffModel}
        tryTriggerNux={this.tryTriggerNux.bind(this, NUX_DIFF_VIEW_ID)}
      />,
      hostElement,
    );
    this._activateDiffPath(diffEntityOptions);

    const destroySubscription = hostElement.onDidDestroy(() => {
      ReactDOM.unmountComponentAtNode(hostElement);
      diffModel.deactivate();
      destroySubscription.dispose();
      this._subscriptions.remove(destroySubscription);
      this._diffViewElement = null;
      this._diffViewComponent = null;
    });

    this._subscriptions.add(
      new Disposable(() => { hostElement.destroy(); }),
      destroySubscription,
    );

    track('diff-view-open');
    return hostElement;
  }

  _activateDiffPath(diffEntityOptions: DiffEntityOptions): void {
    if (this._diffViewModel == null) {
      return;
    }
    if (!diffEntityOptions.file && !diffEntityOptions.directory && this._cwdApi != null) {
      const directory = this._cwdApi.getCwd();
      if (directory != null) {
        diffEntityOptions.directory = directory.getPath();
      }
    }
    this._diffViewModel.diffEntity(diffEntityOptions);
  }


  consumeToolBar(getToolBar: GetToolBar): IDisposable {
    const toolBar = getToolBar('nuclide-diff-view');
    const button = toolBar.addButton({
      icon: 'git-branch',
      callback: 'nuclide-diff-view:open',
      tooltip: 'Open Diff View',
      priority: 300,
    }).element;
    button.classList.add('diff-view-count');

    const diffModel = this._getDiffViewModel();
    let lastCount = null;
    const updateToolbarCount = () => {
      const count = diffModel.getState().dirtyFileChanges.size;
      if (count !== lastCount) {
        button.classList.toggle('positive-count', count > 0);
        button.classList.toggle('max-count', count > 99);
        button.dataset.count = count === 0 ? '' : (count > 99 ? '99+' : String(count));
        lastCount = count;
      }
    };
    updateToolbarCount();

    const toolBarSubscriptions = new CompositeDisposable(
      diffModel.onDidUpdateState(() => { updateToolbarCount(); }),
      new Disposable(() => { toolBar.removeItems(); }),
    );
    this._subscriptions.add(toolBarSubscriptions);
    return toolBarSubscriptions;
  }

  getHomeFragments(): HomeFragments {
    return {
      feature: {
        title: 'Diff View',
        icon: 'git-branch',
        description: (
          <span>
            Launches an editable side-by-side compare view across mercurial dirty and commits
            changes, allowing committing and pushing changes to phabricator.
          </span>
        ),
        command: 'nuclide-diff-view:open',
      },
      priority: 3,
    };
  }

  serialize(): SerializedDiffViewState {
    if (this._activeDiffView == null || this._diffViewModel == null) {
      return {
        visible: false,
      };
    }
    const {commitMode, filePath, viewMode} = this._diffViewModel.getState();
    return {
      visible: true,
      activeFilePath: filePath,
      viewMode,
      commitMode,
    };
  }

  /**
   * The diff-view package can consume providers that return React components to
   * be rendered inline.
   * A uiProvider must have a method composeUiElements with the following spec:
   * @param filePath The path of the file the diff view is opened for
   * @return An array of InlineComments (defined above) to be rendered into the
   *         diff view
   */
  consumeUIProvider(provider: UIProvider) {
    this._uiProviders.push(provider);
    if (this._diffViewModel != null) {
      this._diffViewModel.setUiProviders(this._uiProviders);
    }
    return;
  }

  consumeCwdApi(api: CwdApi): void {
    this._cwdApi = api;
  }

  addItemsToFileTreeContextMenu(contextMenu: FileTreeContextMenu): IDisposable {
    const menuItemDescriptions = new CompositeDisposable();
    menuItemDescriptions.add(contextMenu.addItemToSourceControlMenu(
      {
        label: 'Open in Diff View',
        command: 'nuclide-diff-view:open-context',
        shouldDisplay() {
          return shouldDisplayDiffTreeItem(contextMenu);
        },
      },
      DIFF_VIEW_FILE_TREE_CONTEXT_MENU_PRIORITY,
    ));
    menuItemDescriptions.add(contextMenu.addItemToSourceControlMenu(
      {
        label: 'Commit',
        command: 'nuclide-diff-view:commit-context',
        shouldDisplay() {
          return shouldDisplayDiffTreeItem(contextMenu);
        },
      },
      COMMIT_FILE_TREE_CONTEXT_MENU_PRIORITY,
    ));
    menuItemDescriptions.add(contextMenu.addItemToSourceControlMenu(
      {
        label: 'Amend',
        command: 'nuclide-diff-view:amend-context',
        shouldDisplay() {
          return shouldDisplayDiffTreeItem(contextMenu);
        },
      },
      AMEND_FILE_TREE_CONTEXT_MENU_PRIORITY,
    ));
    menuItemDescriptions.add(contextMenu.addItemToSourceControlMenu(
      {
        label: 'Publish to Phabricator',
        command: 'nuclide-diff-view:publish-context',
        shouldDisplay() {
          return shouldDisplayDiffTreeItem(contextMenu);
        },
      },
      PUBLISH_FILE_TREE_CONTEXT_MENU_PRIORITY,
    ));

    this._subscriptions.add(menuItemDescriptions);

    // We don't need to dispose of the menuItemDescriptions when the provider is disabled -
    // it needs to be handled by the provider itself. We only should remove it from the list
    // of the disposables we maintain.
    return new Disposable(() => {
      this._subscriptions.remove(menuItemDescriptions);
    });
  }

  __getDiffViewComponent() {
    return this._diffViewComponent;
  }

  tryTriggerNux(nuxID: number): void {
    if (this._tryTriggerNuxService != null) {
      this._tryTriggerNuxService(nuxID);
    }
  }

  consumeRegisterNuxService(addNewNux: RegisterNux): IDisposable {
    const disposable = addNewNux(createDiffViewNux());
    this._subscriptions.add(disposable);
    return disposable;
  }

  consumeTriggerNuxService(triggerNuxService: TriggerNux): void {
    this._tryTriggerNuxService = triggerNuxService;
  }

  dispose(): void {
    this._subscriptions.dispose();
  }
}

export default createPackage(Activation);
