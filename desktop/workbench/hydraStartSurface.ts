import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IRecentFolder, IRecentWorkspace, IWorkspacesService, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { IHostService } from '../../../services/host/browser/host.js';

const MAX_RECENT_ENTRIES = 8;

// Cursor-style start surface: replaces the keybinding-tip shortcuts with
// project entry points when no folder or workspace is open.
export async function renderHydraStartSurface(
	container: HTMLElement,
	commandService: ICommandService,
	workspacesService: IWorkspacesService,
	hostService: IHostService,
	productService: IProductService
): Promise<void> {
	clearNode(container);

	const root = append(container, $('.hydra-start-surface'));

	const titleRow = append(root, $('.hydra-start-surface-title-row'));
	append(titleRow, $('.hydra-start-surface-logo'));
	append(titleRow, $('.hydra-start-surface-title', undefined, productService.nameLong));

	const actions = append(root, $('.hydra-start-surface-actions'));

	const openProject = append(actions, $('button.hydra-start-surface-card'));
	openProject.appendChild(renderIcon(Codicon.folderOpened));
	append(openProject, $('span.hydra-start-surface-card-label', undefined, localize('hydra.startSurface.openProject', "Open project")));
	openProject.onclick = () => commandService.executeCommand('workbench.action.files.openFolder');

	const cloneRepo = append(actions, $('button.hydra-start-surface-card'));
	cloneRepo.appendChild(renderIcon(Codicon.cloudDownload));
	append(cloneRepo, $('span.hydra-start-surface-card-label', undefined, localize('hydra.startSurface.cloneRepo', "Clone repo")));
	cloneRepo.onclick = () => commandService.executeCommand('git.clone');

	let recents: Array<IRecentFolder | IRecentWorkspace> = [];
	try {
		recents = (await workspacesService.getRecentlyOpened()).workspaces.slice(0, MAX_RECENT_ENTRIES);
	} catch {
		// Best-effort: an empty recents list is a perfectly valid start surface.
	}

	if (recents.length === 0) {
		return;
	}

	const recentsSection = append(root, $('.hydra-start-surface-recents'));
	append(recentsSection, $('.hydra-start-surface-recents-title', undefined, localize('hydra.startSurface.recent', "Recent projects")));
	const recentsList = append(recentsSection, $('.hydra-start-surface-recents-list'));

	for (const entry of recents) {
		const isFolder = isRecentFolder(entry);
		const uri = isFolder ? entry.folderUri : isRecentWorkspace(entry) ? entry.workspace.configPath : undefined;
		if (!uri) {
			continue;
		}

		const item = append(recentsList, $('button.hydra-start-surface-recent-item'));
		item.appendChild(renderIcon(isFolder ? Codicon.folder : Codicon.fileSubmodule));

		const text = append(item, $('.hydra-start-surface-recent-item-text'));
		append(text, $('.hydra-start-surface-recent-item-label', undefined, entry.label || basename(uri)));
		append(text, $('.hydra-start-surface-recent-item-path', undefined, uri.fsPath));

		item.onclick = () => {
			if (isFolder) {
				hostService.openWindow([{ folderUri: entry.folderUri }]);
			} else if (isRecentWorkspace(entry)) {
				hostService.openWindow([{ workspaceUri: entry.workspace.configPath }]);
			}
		};
	}
}
