/** Shimmer placeholder shown in the grid during the first load of a category. */
export default function NewsCardSkeleton() {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-surface overflow-hidden animate-pulse">
      <div className="aspect-[16/9] bg-bg-elevated" />
      <div className="p-3.5 space-y-2.5">
        <div className="h-2.5 w-20 rounded bg-bg-elevated" />
        <div className="h-3.5 w-full rounded bg-bg-elevated" />
        <div className="h-3.5 w-4/5 rounded bg-bg-elevated" />
        <div className="h-2.5 w-full rounded bg-bg-elevated/70" />
        <div className="h-2.5 w-2/3 rounded bg-bg-elevated/70" />
      </div>
    </div>
  );
}
