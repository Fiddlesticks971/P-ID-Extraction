import { compilePattern } from "../lib/tagPatterns";
import type { AppSettings, TagPattern } from "../types";

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
  onReapplyPatterns: () => void;
  onResetDefaults: () => void;
}

function newPattern(): TagPattern {
  return {
    id: `custom-${Date.now()}`,
    name: "New Pattern",
    pattern: String.raw`(?<func>[A-Z]{2,4})-(?<loop>\d{2,4})`,
    enabled: true,
    description: "Custom pattern",
  };
}

export function SettingsPanel({
  settings,
  onChange,
  onClose,
  onReapplyPatterns,
  onResetDefaults,
}: SettingsPanelProps) {
  function updatePattern(id: string, patch: Partial<TagPattern>) {
    onChange({
      ...settings,
      patterns: settings.patterns.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });
  }

  function deletePattern(id: string) {
    onChange({ ...settings, patterns: settings.patterns.filter((p) => p.id !== id) });
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Extraction Settings</h2>
        <button onClick={onClose} aria-label="Close settings">
          &times;
        </button>
      </div>

      <label className="settings-field">
        OCR render scale ({settings.ocrScale.toFixed(1)}x)
        <input
          type="range"
          min={1}
          max={4}
          step={0.25}
          value={settings.ocrScale}
          onChange={(e) => onChange({ ...settings, ocrScale: Number(e.target.value) })}
        />
        <span className="muted">Higher improves accuracy on small text but is slower.</span>
      </label>

      <label className="settings-field">
        Stacked-text grouping gap ({settings.groupStackedText.toFixed(2)})
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={settings.groupStackedText}
          onChange={(e) => onChange({ ...settings, groupStackedText: Number(e.target.value) })}
        />
        <span className="muted">
          Controls how close two stacked lines of text (e.g. bubble tags) must be to merge into one tag.
        </span>
      </label>

      <label className="settings-field settings-checkbox">
        <input
          type="checkbox"
          checked={settings.detectBubbles}
          onChange={(e) => onChange({ ...settings, detectBubbles: e.target.checked })}
        />
        Detect circular instrument bubbles
        <span className="muted">
          Whole-page OCR reliably misses text packed tightly inside circular instrument symbols. When
          enabled, each detected circle is cropped, isolated from its stroke/neighbors, and OCR'd
          separately &mdash; this is slower (roughly one extra OCR pass per bubble) but recovers most of
          those tags.
        </span>
      </label>

      {settings.detectBubbles && (
        <>
          <label className="settings-field">
            Min bubble radius ({settings.bubbleMinRadius}px @ 1x scale)
            <input
              type="range"
              min={4}
              max={60}
              step={1}
              value={settings.bubbleMinRadius}
              onChange={(e) => onChange({ ...settings, bubbleMinRadius: Number(e.target.value) })}
            />
          </label>
          <label className="settings-field">
            Max bubble radius ({settings.bubbleMaxRadius}px @ 1x scale)
            <input
              type="range"
              min={4}
              max={80}
              step={1}
              value={settings.bubbleMaxRadius}
              onChange={(e) => onChange({ ...settings, bubbleMaxRadius: Number(e.target.value) })}
            />
            <span className="muted">
              Radius search range for detecting instrument bubbles, scaled by the OCR render scale above.
              Widen this if bubbles on your drawing aren't being found.
            </span>
          </label>
        </>
      )}

      <p className="muted settings-note">
        OCR-time settings (render scale, bubble detection) only take effect on the next upload &mdash;
        &quot;Re-run Extraction&quot; below only re-applies tag patterns to the text already scanned.
      </p>

      <div className="settings-patterns">
        <div className="settings-patterns-header">
          <h3>Tag Patterns</h3>
          <button onClick={() => onChange({ ...settings, patterns: [...settings.patterns, newPattern()] })}>
            + Add Pattern
          </button>
        </div>
        {settings.patterns.map((pattern) => {
          const valid = compilePattern(pattern) !== null;
          return (
            <div key={pattern.id} className="pattern-row">
              <label className="pattern-enabled">
                <input
                  type="checkbox"
                  checked={pattern.enabled}
                  onChange={(e) => updatePattern(pattern.id, { enabled: e.target.checked })}
                />
              </label>
              <div className="pattern-fields">
                <input
                  className="pattern-name"
                  value={pattern.name}
                  onChange={(e) => updatePattern(pattern.id, { name: e.target.value })}
                />
                <input
                  className={`pattern-regex${valid ? "" : " invalid"}`}
                  value={pattern.pattern}
                  onChange={(e) => updatePattern(pattern.id, { pattern: e.target.value })}
                  spellCheck={false}
                />
                {!valid && <span className="pattern-error">Invalid regular expression</span>}
                {pattern.description && <p className="muted pattern-desc">{pattern.description}</p>}
              </div>
              <button className="danger small" onClick={() => deletePattern(pattern.id)}>
                Delete
              </button>
            </div>
          );
        })}
      </div>

      <div className="settings-actions">
        <button onClick={onResetDefaults}>Reset to Defaults</button>
        <button className="primary" onClick={onReapplyPatterns}>
          Re-run Extraction
        </button>
      </div>
    </div>
  );
}
