import { useEffect, useRef, useState } from "react";
import type { DisruptRules, LeadConfig, PolishRules } from "../lib/types";
import type { DisruptionReport } from "../lib/disrupt";
import type { Envelope } from "../lib/analyze";
import type { FillerHit, Transcript } from "../lib/polish";
import { fmtTime } from "../lib/timeline";
import { Btn, Note, Section, Slider, Toggle } from "./ui";
import { cn } from "../utils/cn";

function DropList({
  title,
  items,
  format,
}: {
  title: string;
  items: { start: number; end: number }[];
  format: (s: { start: number; end: number }) => string;
}) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-black/25 p-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-1 flex w-full items-center justify-between text-left"
      >
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          {title} · {items.length}
        </span>
        <span className="text-[10px] text-slate-500">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <ul className="max-h-32 space-y-0.5 overflow-y-auto">
          {items.slice(0, 200).map((r, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-2 font-mono text-[10px] text-slate-400"
            >
              <span>{format(r)}</span>
              <span className="text-rose-300">−{fmtTime(r.end - r.start, true)}</span>
            </li>
          ))}
          {items.length > 200 && (
            <li className="text-[10px] text-slate-600">… {items.length - 200} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function Polish({
  hasSource,
  duration,
  scanning,
  scanProgress,
  scanChannel,
  micEnv,
  contentEnv,
  disruptions,
  transcript,
  fillers,
  pauses,
  takes,
  stutters,
  rules,
  setRules,
  disruptRules,
  setDisruptRules,
  lead,
  setLead,
  reactionStart,
  onScan,
  onStopScan,
  onTranscriptFile,
  onTranscriptText,
  canTranscribe,
  trBusy,
  trProgress,
  trLang,
  setTrLang,
  onTranscribe,
  trError,
  onApproxAlign,
  onBuildSkeleton,
  onApplyPolish,
  onApplyDisrupt,
  onApplyAll,
  savings,
  bodySpan,
}: {
  hasSource: boolean;
  duration: number;
  scanning: boolean;
  scanProgress: number;
  scanChannel: "mic" | "content";
  micEnv: Envelope | null;
  contentEnv: Envelope | null;
  disruptions: DisruptionReport | null;
  transcript: Transcript | null;
  fillers: FillerHit[];
  pauses: { start: number; end: number }[];
  takes: { start: number; end: number }[];
  stutters: { start: number; end: number }[];
  rules: PolishRules;
  setRules: React.Dispatch<React.SetStateAction<PolishRules>>;
  disruptRules: DisruptRules;
  setDisruptRules: React.Dispatch<React.SetStateAction<DisruptRules>>;
  lead: LeadConfig;
  setLead: React.Dispatch<React.SetStateAction<LeadConfig>>;
  reactionStart: number | null;
  onScan: (ch: "mic" | "content") => void;
  onStopScan: () => void;
  onTranscriptFile: (f: File) => void;
  onTranscriptText: (t: string) => void;
  /** server speech-to-text (Colab engine): transcribes intro+outro in place */
  canTranscribe: boolean;
  trBusy: boolean;
  trProgress: number;
  trLang: string;
  setTrLang: (v: string) => void;
  onTranscribe: () => void;
  trError: string;
  onApproxAlign: () => void;
  onBuildSkeleton: () => void;
  onApplyPolish: () => void;
  onApplyDisrupt: () => void;
  onApplyAll: () => void;
  savings: number;
  bodySpan: { start: number; end: number };
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  useEffect(() => {
    if (!transcript) return;
  }, [transcript]);

  const ready = !!micEnv || !!contentEnv;
  const totalDrops = [...pauses, ...takes, ...stutters];

  return (
    <div className="space-y-2.5">
      <Section title="1 · Read the audio">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          Two passes over the file, both silent and fast. The <strong>mic</strong> pass finds
          your pauses, stumbles and repeated takes in the intro and outro. The{" "}
          <strong>content</strong> pass finds where the video you were watching froze and you had
          to rewind.
        </p>
        <div className="flex gap-1.5">
          <Btn
            variant={scanChannel === "mic" ? "primary" : "ghost"}
            className="flex-1"
            disabled={!hasSource || scanning}
            onClick={() => onScan("mic")}
          >
            Mic pass
          </Btn>
          <Btn
            variant={scanChannel === "content" ? "primary" : "ghost"}
            className="flex-1"
            disabled={!hasSource || scanning}
            onClick={() => onScan("content")}
          >
            Content pass
          </Btn>
        </div>
        {scanning && (
          <>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/50 ring-1 ring-inset ring-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-violet-400"
                style={{ width: `${Math.round(scanProgress * 100)}%` }}
              />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="font-mono text-[10px] text-sky-300">
                {scanChannel} · {Math.round(scanProgress * 100)}%
              </p>
              <Btn variant="danger" className="ml-auto" onClick={onStopScan}>
                Stop
              </Btn>
            </div>
          </>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px]">
          <span
            className={cn(
              "rounded border px-1.5 py-0.5",
              micEnv ? "border-sky-400/30 bg-sky-500/10 text-sky-200" : "border-white/10 text-slate-500"
            )}
          >
            mic {micEnv ? "✓" : "—"}
          </span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5",
              contentEnv
                ? "border-teal-400/30 bg-teal-500/10 text-teal-200"
                : "border-white/10 text-slate-500"
            )}
          >
            content {contentEnv ? "✓" : "—"}
          </span>
          <span
            className={cn(
              "rounded border px-1.5 py-0.5",
              transcript
                ? "border-violet-400/30 bg-violet-500/10 text-violet-200"
                : "border-white/10 text-slate-500"
            )}
          >
            transcript {transcript ? "✓" : "—"}
          </span>
        </div>
      </Section>

      <Section title="2 · Transcript (optional)">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          Needed for removing <em>um</em>, <em>uh</em>, <em>like</em> and repeated words — pauses
          and takes are caught from the audio alone.
        </p>
        {canTranscribe ? (
          <div className="mb-2 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.07] p-2">
            <div className="flex items-center gap-1.5">
              <select
                value={trLang}
                disabled={trBusy}
                onChange={(e) => setTrLang(e.target.value)}
                className="h-7 shrink-0 rounded-lg border border-white/10 bg-black/40 px-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-400/50 disabled:opacity-50"
                title="Spoken language"
              >
                <option value="auto">Auto</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
              <Btn
                variant="primary"
                className="flex-1"
                disabled={trBusy || !hasSource}
                onClick={onTranscribe}
              >
                {trBusy
                  ? `Transcribing… ${Math.round(trProgress * 100)}%`
                  : "Transcribe intro + outro"}
              </Btn>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
              Runs Whisper on the server against your mic channel — only the intro/outro spans,
              where fillers matter. Or load a file below instead.
            </p>
            {trError && (
              <p className="mt-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[10px] leading-relaxed text-rose-200">
                {trError}
              </p>
            )}
          </div>
        ) : (
          <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
            Whisper, or any tool that exports SRT / VTT / JSON with timestamps, works. (Connect
            the Colab engine and this tab transcribes the intro/outro for you.)
          </p>
        )}
        <div className="flex gap-1.5">
          <Btn className="flex-1" onClick={() => fileRef.current?.click()}>
            Load .srt / .vtt / .json
          </Btn>
          <Btn className="flex-1" onClick={() => setShowPaste((s) => !s)}>
            Paste
          </Btn>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,.vtt,.txt,.json,text/plain,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onTranscriptFile(f);
          }}
        />
        {showPaste && (
          <div className="mt-2">
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={"00:00:01,000 --> 00:00:04,000\nso um today we're going to…"}
              className="w-full resize-y rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[10px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-violet-400/50"
            />
            <Btn variant="primary" className="mt-1.5 w-full" onClick={() => onTranscriptText(paste)}>
              Use this transcript
            </Btn>
          </div>
        )}
        {transcript && (
          <div className="mt-2 rounded-lg border border-white/10 bg-black/25 p-2">
            <p className="text-[10px] text-slate-400">
              {transcript.words.length} words ·{" "}
              <span className={transcript.timed ? "text-emerald-300" : "text-amber-300"}>
                {transcript.timed ? "timed" : "no timings"}
              </span>{" "}
              · {transcript.source}
            </p>
            <p className="mt-1 max-h-24 overflow-y-auto text-[11px] leading-relaxed text-slate-300">
              {transcript.words.map((w) => w.text).join(" ").slice(0, 900)}
              {transcript.words.length > 150 ? "…" : ""}
            </p>
          </div>
        )}
        {transcript && !transcript.timed && (
          <Btn className="mt-1.5 w-full" onClick={onApproxAlign}>
            Spread words over intro &amp; outro anyway
          </Btn>
        )}
      </Section>

      {transcript && (
        <Section title="3 · Words to drop">
          <div className="space-y-2">
            <Toggle
              label="Remove um / uh / er / hmm"
              value={rules.dropFillers}
              onChange={(v) => setRules((r) => ({ ...r, dropFillers: v }))}
            />
            <Toggle
              label="Remove like / basically / you know"
              hint="riskier — sometimes those words are doing work"
              value={rules.dropSoftFillers}
              onChange={(v) => setRules((r) => ({ ...r, dropSoftFillers: v }))}
            />
            {fillers.length > 0 && (
              <div className="rounded-lg border border-white/10 bg-black/25 p-2">
                <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">
                  {fillers.length} filler{fillers.length === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap gap-1">
                  {fillers.slice(0, 60).map((f, i) => (
                    <span
                      key={i}
                      className={cn(
                        "rounded px-1 text-[10px]",
                        f.kind === "filler"
                          ? "bg-rose-500/15 text-rose-200"
                          : "bg-amber-500/15 text-amber-200"
                      )}
                    >
                      {f.text}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      <Section title="4 · Pauses &amp; takes">
        <div className="space-y-2">
          <Slider
            label="Tighten pauses over"
            value={rules.maxPause}
            min={0.3}
            max={5}
            step={0.1}
            display={`${rules.maxPause.toFixed(1)} s`}
            onChange={(v) => setRules((r) => ({ ...r, maxPause: v }))}
            hint="anything longer inside the intro / outro gets squeezed"
          />
          <Slider
            label="Leave"
            value={rules.keepPause}
            min={0}
            max={1.5}
            step={0.05}
            display={`${rules.keepPause.toFixed(2)} s`}
            onChange={(v) => setRules((r) => ({ ...r, keepPause: v }))}
            hint="a beat still breathes — zero sounds robotic"
          />
          <Slider
            label="A repeat this long is a stumble"
            value={rules.minRepeat}
            min={0.2}
            max={3}
            step={0.1}
            display={`${rules.minRepeat.toFixed(1)} s`}
            onChange={(v) => setRules((r) => ({ ...r, minRepeat: v }))}
          />
          <Slider
            label="A repeat this long is another take"
            value={rules.minTake}
            min={1}
            max={15}
            step={0.5}
            display={`${rules.minTake.toFixed(1)} s`}
            hint="keeps the LAST take, which is the one you like"
            onChange={(v) => setRules((r) => ({ ...r, minTake: v }))}
          />
          <Slider
            label="Silence needed between takes"
            value={rules.takeGap}
            min={0.2}
            max={3}
            step={0.1}
            display={`${rules.takeGap.toFixed(1)} s`}
            onChange={(v) => setRules((r) => ({ ...r, takeGap: v }))}
          />
        </div>
        {ready && totalDrops.length > 0 && (
          <div className="mt-2 space-y-1.5">
            <DropList title="Repeated takes (keeping the last)" items={takes} format={(r) => `${fmtTime(r.start, true)} → ${fmtTime(r.end, true)}`} />
            <DropList title="Stumbles" items={stutters} format={(r) => `${fmtTime(r.start, true)} → ${fmtTime(r.end, true)}`} />
            <DropList title="Long pauses" items={pauses} format={(r) => `${fmtTime(r.start, true)} → ${fmtTime(r.end, true)}`} />
          </div>
        )}
      </Section>

      <Section title="5 · Reaction start &amp; lead-in">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          {reactionStart === null
            ? "Run the content pass to find where the video you're watching actually starts."
            : `Content starts at ${fmtTime(reactionStart, true)}.`}
        </p>
        <div className="space-y-2">
          <Slider
            label="Keep before the switch"
            value={lead.leadIn}
            min={0}
            max={5}
            step={0.25}
            display={`${lead.leadIn.toFixed(2)} s`}
            hint="your “let's go” sits here, in the intro"
            onChange={(v) => setLead((l) => ({ ...l, leadIn: v }))}
          />
          <Slider
            label="Black content block"
            value={lead.black}
            min={0}
            max={4}
            step={0.25}
            display={`${lead.black.toFixed(2)} s`}
            hint="reaction layout is up, content still black"
            onChange={(v) => setLead((l) => ({ ...l, black: v }))}
          />
          <Btn
            variant="primary"
            className="w-full"
            disabled={reactionStart === null}
            onClick={onBuildSkeleton}
          >
            Rebuild intro / lead / reaction / outro
          </Btn>
        </div>
      </Section>

      <Section title="6 · Repair the interruptions">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
          Where the connection dropped you rewound and re-watched a stretch. Keeping the first
          playthrough and cutting the disruption plus the duplicate gives an uninterrupted flow.
        </p>
        <div className="space-y-2">
          <Slider
            label="A repeat this long is a rewind"
            value={disruptRules.minRepeat}
            min={1}
            max={15}
            step={0.5}
            display={`${disruptRules.minRepeat.toFixed(1)} s`}
            onChange={(v) => setDisruptRules((d) => ({ ...d, minRepeat: v }))}
          />
          <Slider
            label="Minimum rewind distance"
            value={disruptRules.minSeparation}
            min={1}
            max={30}
            step={1}
            display={`${disruptRules.minSeparation} s`}
            hint="stops ordinary repetition inside the video being mistaken for a rewind"
            onChange={(v) => setDisruptRules((d) => ({ ...d, minSeparation: v }))}
          />
          <Toggle
            label="Also trim frozen / silent stretches"
            hint="the player sat there doing nothing"
            value={disruptRules.trimDeadAir}
            onChange={(v) => setDisruptRules((d) => ({ ...d, trimDeadAir: v }))}
          />
          {disruptRules.trimDeadAir && (
            <div className="grid grid-cols-2 gap-x-3">
              <Slider
                label="Silence over"
                value={disruptRules.deadAir}
                min={1}
                max={30}
                step={1}
                display={`${disruptRules.deadAir} s`}
                onChange={(v) => setDisruptRules((d) => ({ ...d, deadAir: v }))}
              />
              <Slider
                label="Leave"
                value={disruptRules.keepDead}
                min={0}
                max={4}
                step={0.25}
                display={`${disruptRules.keepDead.toFixed(2)} s`}
                onChange={(v) => setDisruptRules((d) => ({ ...d, keepDead: v }))}
              />
            </div>
          )}
        </div>
        {disruptions && (
          <div className="mt-2 space-y-1.5">
            <p className="text-[10px] text-slate-400">
              {disruptions.repeats.length} rewind{disruptions.repeats.length === 1 ? "" : "s"} ·{" "}
              {disruptions.deadAir.length} freeze{disruptions.deadAir.length === 1 ? "" : "s"} ·{" "}
              <span className="text-teal-300">
                {fmtTime(disruptions.wasted)} of dead weight
              </span>
            </p>
            <DropList
              title="To remove"
              items={disruptions.drops}
              format={(r) => `${fmtTime(r.start)} → ${fmtTime(r.end)}`}
            />
          </div>
        )}
      </Section>

      <Section title="7 · Apply">
        <div className="grid grid-cols-2 gap-1.5 text-center">
          <div className="rounded-lg border border-white/10 bg-black/25 p-1.5">
            <p className="text-[9px] uppercase tracking-wider text-slate-500">source</p>
            <p className="font-mono text-[13px] text-slate-200">{fmtTime(duration)}</p>
          </div>
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-1.5">
            <p className="text-[9px] uppercase tracking-wider text-slate-400">patreon cut</p>
            <p className="font-mono text-[13px] text-emerald-300">{fmtTime(Math.max(0, duration - savings))}</p>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
          The reaction itself is left whole — only your pauses, stumbles, extra takes and the
          connection dropouts come out. That's your Patreon version.
        </p>
        <div className="mt-2 space-y-1.5">
          <Btn variant="primary" className="w-full py-1.5" onClick={onApplyAll} disabled={!ready}>
            Apply everything
          </Btn>
          <div className="flex gap-1.5">
            <Btn className="flex-1" onClick={onApplyPolish} disabled={!ready}>
              Only intro / outro
            </Btn>
            <Btn className="flex-1" onClick={onApplyDisrupt} disabled={!disruptions}>
              Only interruptions
            </Btn>
          </div>
        </div>
        <p className="mt-2 font-mono text-[10px] text-slate-500">
          reaction part: {fmtTime(bodySpan.end - bodySpan.start)} · untouched
        </p>
      </Section>

      {!ready && hasSource && (
        <Note>
          Run at least the mic pass — that alone finds the pauses and the extra takes, no
          transcript needed.
        </Note>
      )}
      {!hasSource && <Note>Load a recording first.</Note>}
    </div>
  );
}
