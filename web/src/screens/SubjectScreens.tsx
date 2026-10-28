/**
 * The subject form: one question per screen, prefilled from the last
 * scan on this device. Sex selects the reference values; age is part of the analysis.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import { Screen } from "../components/layout/Screen";
import { Button } from "../components/ui/Button";
import { RadioCards } from "../components/ui/RadioCards";
import { TextField } from "../components/ui/TextField";
import { useScan } from "../scan/ScanContext";
import { AGE_MAX, parseAge, SEXES, type Sex } from "../scan/subject";
import { step } from "./steps";

const FORM_ID = "subject-form";

export function SubjectSexScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, dispatch } = useScan();
  const headingId = useId();
  const helpId = useId();
  const [sex, setSex] = useState<Sex | null>(state.draft.sex ?? null);
  const [error, setError] = useState(false);
  const group = useRef<HTMLDivElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (sex === null) {
      setError(true);
      group.current?.querySelector<HTMLElement>("[role=radio]")?.focus();
      return;
    }
    dispatch({ type: "draft", patch: { sex } });
    navigate("/subject/age");
  }

  return (
    <Screen
      title={t("subject.sex.title")}
      headingId={headingId}
      step={step(t, "subject")}
      onBack={() => navigate("/")}
      actions={
        <Button variant="primary" type="submit" form={FORM_ID}>
          {t("subject.continue")}
        </Button>
      }
    >
      <p id={helpId} className="mb-6 text-ink-2">
        {t("subject.sex.help")}
      </p>
      <form id={FORM_ID} noValidate onSubmit={submit} className="max-w-field">
        <RadioCards
          groupRef={group}
          labelledBy={headingId}
          describedBy={helpId}
          value={sex}
          onChange={(v) => {
            setSex(v);
            setError(false);
          }}
          options={SEXES.map((value) => ({ value, label: t(`subject.sex.${value}`) }))}
          error={error ? t("subject.sex.error") : null}
        />
      </form>
    </Screen>
  );
}

export function SubjectAgeScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, confirmSubject } = useScan();
  const [text, setText] = useState(state.draft.age === undefined ? "" : String(state.draft.age));
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sex = state.draft.sex;

  if (sex === undefined) return <Navigate to="/subject" replace />;

  function submit(e: FormEvent) {
    e.preventDefault();
    const age = parseAge(text);
    if (age === null || sex === undefined) {
      setError(true);
      input.current?.focus();
      return;
    }
    confirmSubject({ sex, age });
    navigate("/scan/frontal/guide");
  }

  return (
    <Screen
      title={t("subject.age.title")}
      step={step(t, "subject")}
      onBack={() => navigate("/subject")}
      actions={
        <Button variant="primary" type="submit" form={FORM_ID}>
          {t("subject.continue")}
        </Button>
      }
    >
      <form id={FORM_ID} noValidate onSubmit={submit}>
        <TextField
          inputRef={input}
          label={t("subject.age.label")}
          help={t("subject.age.help")}
          error={error ? t("subject.age.error") : null}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
          name="age"
          type="text"
          inputMode="numeric"
          // iOS shows its number pad for exactly this pattern; parseAge also takes Thai numerals.
          pattern="[0-9]*"
          maxLength={String(AGE_MAX).length}
          autoComplete="off"
          enterKeyHint="done"
          className="max-w-field"
          inputClassName="max-w-field-short"
        />
      </form>
    </Screen>
  );
}
