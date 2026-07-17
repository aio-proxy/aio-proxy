import type { ProviderRouteSnapshot, ProviderSnapshotLease, RetiredProviderSnapshot } from "./runtime";

type ManagedSnapshot = {
  readonly snapshot: ProviderRouteSnapshot;
  readonly providerIds: ReadonlySet<string>;
  references: number;
  retired: boolean;
  drained: boolean;
  readonly whenDrained: Promise<void>;
  readonly resolveDrained: () => void;
};

function managed(snapshot: ProviderRouteSnapshot): ManagedSnapshot {
  let resolveDrained = () => {};
  const whenDrained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return {
    snapshot,
    providerIds: new Set(snapshot.providers.map(({ id }) => id)),
    references: 0,
    retired: false,
    drained: false,
    whenDrained,
    resolveDrained,
  };
}

function drain(value: ManagedSnapshot): void {
  if (!value.retired || value.references !== 0 || value.drained) return;
  value.drained = true;
  value.resolveDrained();
}

export type SnapshotManager = {
  readonly acquire: () => ProviderSnapshotLease;
  readonly current: () => ProviderRouteSnapshot;
  readonly swap: (candidate: ProviderRouteSnapshot) => RetiredProviderSnapshot;
  readonly canDeleteAccount: (providerId: string) => boolean;
};

export function createSnapshotManager(initial: ProviderRouteSnapshot): SnapshotManager {
  let current = managed(initial);
  const retired = new Set<ManagedSnapshot>();

  return {
    acquire() {
      const acquired = current;
      acquired.references++;
      let released = false;
      return {
        snapshot: acquired.snapshot,
        release() {
          if (released) return;
          released = true;
          acquired.references--;
          drain(acquired);
        },
      };
    },
    current() {
      return current.snapshot;
    },
    swap(candidate) {
      const previous = current;
      previous.retired = true;
      retired.add(previous);
      void previous.whenDrained.then(() => retired.delete(previous));
      current = managed(candidate);
      drain(previous);
      return {
        providerIds: previous.providerIds,
        whenDrained: previous.whenDrained,
        whenProviderDrained(providerId) {
          return Promise.all(
            [...retired].filter((value) => value.providerIds.has(providerId)).map((value) => value.whenDrained),
          ).then(() => undefined);
        },
      };
    },
    canDeleteAccount(providerId) {
      if (current.providerIds.has(providerId)) return false;
      for (const value of retired) {
        if (!value.drained && value.providerIds.has(providerId)) return false;
      }
      return true;
    },
  };
}
