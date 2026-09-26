import * as vscode from 'vscode';
import { buildHydraTree, type HydraTree, type TreeHeadItem, type TreeLaneItem, type TreePlanItem } from './core/hydraTree';
import type { HelperJobView, LaneView, SnapshotRole } from './core/model';
import type { Plan } from './core/plans';
import type { PlanJobView } from './core/planRunner';

/**
 * The Hydra activity-bar panel (docs/Lanes_And_Planner_Plan.md, section 3): one
 * TreeView, `hydra.overview`, grouping open lanes, running heads and live plans.
 * The grouping itself is the pure `buildHydraTree` (src/core/hydraTree.ts); this
 * class only turns that into vscode.TreeItems and refreshes on change.
 */
type Row = { kind: 'group'; id: 'lanes' | 'heads' | 'plans'; label: string; count: number }
  | { kind: 'lane'; item: TreeLaneItem } | { kind: 'head'; item: TreeHeadItem } | { kind: 'plan'; item: TreePlanItem };

const laneStateIcon: Record<LaneView['state'], string> = { running: 'debug-start', exited: 'debug-stop', merged: 'check', closed: 'close' };

export class HydraTreeProvider implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Row | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private lanes: readonly LaneView[] = [];
  private heads: readonly HelperJobView[] = [];
  private plans: readonly Plan[] = [];
  private planJobs: Readonly<Record<string, readonly PlanJobView[]>> = {};
  /** The active packs' roles (docs/Packs_Plan.md, "How roles show"), for a lane's description. */
  private roles: readonly SnapshotRole[] = [];

  update(next: { lanes?: readonly LaneView[]; heads?: readonly HelperJobView[]; plans?: readonly Plan[]; planJobs?: Readonly<Record<string, readonly PlanJobView[]>>; roles?: readonly SnapshotRole[] }): void {
    if (next.lanes) this.lanes = next.lanes;
    if (next.heads) this.heads = next.heads;
    if (next.plans) this.plans = next.plans;
    if (next.planJobs) this.planJobs = next.planJobs;
    if (next.roles) this.roles = next.roles;
    this.emitter.fire(undefined);
  }
  private tree(): HydraTree { return buildHydraTree(this.lanes, this.heads, this.plans, this.planJobs, this.roles); }

  getTreeItem(row: Row): vscode.TreeItem {
    if (row.kind === 'group') {
      const item = new vscode.TreeItem(`${row.label} (${row.count})`, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `hydra-group-${row.id}`;
      return item;
    }
    if (row.kind === 'lane') {
      const lane = row.item;
      const item = new vscode.TreeItem(lane.label, vscode.TreeItemCollapsibleState.None);
      item.description = lane.description;
      item.iconPath = new vscode.ThemeIcon(laneStateIcon[lane.state], lane.conflicts ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined);
      item.contextValue = lane.dirty ? 'lane-dirty' : 'lane';
      item.command = { command: 'hydra.openLanes', title: 'Open in Lanes', arguments: [lane.id] };
      return item;
    }
    if (row.kind === 'head') {
      const head = row.item;
      const item = new vscode.TreeItem(head.label, vscode.TreeItemCollapsibleState.None);
      item.description = head.description;
      item.iconPath = new vscode.ThemeIcon(head.state === 'blocked' ? 'question' : 'sync~spin');
      item.contextValue = 'head';
      item.command = { command: 'hydra.openCanvas', title: 'Focus on the canvas', arguments: [head.id] };
      return item;
    }
    const plan = row.item;
    const item = new vscode.TreeItem(plan.label, vscode.TreeItemCollapsibleState.None);
    item.description = plan.description;
    item.iconPath = new vscode.ThemeIcon(plan.state === 'running' ? 'sync~spin' : plan.state === 'failed' ? 'warning' : 'circle-outline');
    item.contextValue = 'plan';
    item.command = { command: 'hydra.openAgents', title: 'Open the canvas' };
    return item;
  }

  getChildren(row?: Row): Row[] {
    const tree = this.tree();
    if (!row) {
      // An empty root shows the view's viewsWelcome ("Run several agents at once.").
      if (tree.empty) return [];
      return [
        { kind: 'group', id: 'lanes', label: 'Lanes', count: tree.lanes.length },
        { kind: 'group', id: 'heads', label: 'Heads', count: tree.heads.length },
        { kind: 'group', id: 'plans', label: 'Plans', count: tree.plans.length },
      ];
    }
    if (row.kind !== 'group') return [];
    if (row.id === 'lanes') return tree.lanes.map(item => ({ kind: 'lane', item }));
    if (row.id === 'heads') return tree.heads.map(item => ({ kind: 'head', item }));
    return tree.plans.map(item => ({ kind: 'plan', item }));
  }
  dispose(): void { this.emitter.dispose(); }
}
