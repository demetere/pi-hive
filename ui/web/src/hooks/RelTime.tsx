import { useHive } from "../store";
import { relTime } from "../lib/format";

// Leaf component that subscribes to `now` ALONE, so the 1s tick re-renders only
// these tiny time cells — not the table shells or rows that contain them.
export default function RelTime(props: { ts: string | number; title?: string }) {
  const now = useHive((s) => s.now);
  return <span title={props.title}>{relTime(props.ts, now || Date.now())}</span>;
}
