import React, { useEffect, useState } from 'react';
import { Check, Save, Sparkles, User, Briefcase, GraduationCap, Link2, FileText } from 'lucide-react';
import type { PersonalProfile } from '../types/agent';

interface MemoryPanelProps {
  profile: PersonalProfile;
  onSave: (updated: PersonalProfile) => Promise<void>;
}

export const MemoryPanel: React.FC<MemoryPanelProps> = ({ profile, onSave }) => {
  const [draft, setDraft] = useState<PersonalProfile>(profile);
  const [savedToast, setSavedToast] = useState(false);

  // Keep the form in sync when the profile is updated elsewhere (Knowledge import, extract_to_memory)
  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const updateField = (key: keyof PersonalProfile, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave(draft);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2000);
  };

  const inputClass =
    'w-full bg-[#1E1E21] border border-[#323236] rounded-lg px-3 py-2 text-xs text-[#F3F2EE] placeholder-[#787774] focus:outline-none focus:border-[#D97757] transition-colors';
  const labelClass = 'block text-[11px] font-medium text-[#A19F99] mb-1';

  return (
    <form onSubmit={handleSave} className="flex flex-col h-full overflow-y-auto px-4 py-3 space-y-5">
      {/* Header Banner */}
      <div className="bg-[#222226] border border-[#323236] rounded-xl p-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#F3F2EE]">
            <Sparkles className="w-3.5 h-3.5 text-[#D97757]" />
            Local Personal Memory
          </div>
          <p className="text-[11px] text-[#A19F99] mt-0.5 leading-relaxed">
            Stored 100% locally in Chrome storage. Passed automatically to your local Ollama model when filling forms.
          </p>
        </div>
        <button
          type="submit"
          className="shrink-0 flex items-center gap-1.5 bg-[#D97757] hover:bg-[#E5886A] text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors shadow-sm"
        >
          {savedToast ? (
            <>
              <Check className="w-3.5 h-3.5" />
              Saved
            </>
          ) : (
            <>
              <Save className="w-3.5 h-3.5" />
              Save
            </>
          )}
        </button>
      </div>

      {/* Identity & Contact */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E4E0]">
          <User className="w-3.5 h-3.5 text-[#D97757]" />
          Identity & Contact
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="col-span-2">
            <label className={labelClass}>Full Name</label>
            <input
              type="text"
              value={draft.fullName}
              onChange={(e) => updateField('fullName', e.target.value)}
              placeholder="Jane Doe"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>First Name</label>
            <input
              type="text"
              value={draft.firstName}
              onChange={(e) => updateField('firstName', e.target.value)}
              placeholder="Jane"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Last Name</label>
            <input
              type="text"
              value={draft.lastName}
              onChange={(e) => updateField('lastName', e.target.value)}
              placeholder="Doe"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Email Address</label>
            <input
              type="email"
              value={draft.email}
              onChange={(e) => updateField('email', e.target.value)}
              placeholder="jane@example.com"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Phone Number</label>
            <input
              type="tel"
              value={draft.phone}
              onChange={(e) => updateField('phone', e.target.value)}
              placeholder="+1 (555) 000-0000"
              className={inputClass}
            />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>Location (City, State, Country)</label>
            <input
              type="text"
              value={draft.location}
              onChange={(e) => updateField('location', e.target.value)}
              placeholder="San Francisco, CA"
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Social & Portfolio Links */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E4E0]">
          <Link2 className="w-3.5 h-3.5 text-[#D97757]" />
          Links & Profiles
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelClass}>GitHub URL</label>
            <input
              type="url"
              value={draft.github}
              onChange={(e) => updateField('github', e.target.value)}
              placeholder="https://github.com/..."
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>LinkedIn URL</label>
            <input
              type="url"
              value={draft.linkedin}
              onChange={(e) => updateField('linkedin', e.target.value)}
              placeholder="https://linkedin.com/in/..."
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Portfolio / Website</label>
            <input
              type="url"
              value={draft.portfolio}
              onChange={(e) => updateField('portfolio', e.target.value)}
              placeholder="https://..."
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>X / Twitter URL</label>
            <input
              type="text"
              value={draft.twitter}
              onChange={(e) => updateField('twitter', e.target.value)}
              placeholder="https://x.com/..."
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Education */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E4E0]">
          <GraduationCap className="w-3.5 h-3.5 text-[#D97757]" />
          Education
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="col-span-2">
            <label className={labelClass}>University / College</label>
            <input
              type="text"
              value={draft.university}
              onChange={(e) => updateField('university', e.target.value)}
              placeholder="Your University Name"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Degree</label>
            <input
              type="text"
              value={draft.degree}
              onChange={(e) => updateField('degree', e.target.value)}
              placeholder="B.Tech / B.S."
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Major / Field</label>
            <input
              type="text"
              value={draft.major}
              onChange={(e) => updateField('major', e.target.value)}
              placeholder="Computer Science"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Graduation Year</label>
            <input
              type="text"
              value={draft.graduationYear}
              onChange={(e) => updateField('graduationYear', e.target.value)}
              placeholder="2027"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>GPA / CGPA</label>
            <input
              type="text"
              value={draft.gpa}
              onChange={(e) => updateField('gpa', e.target.value)}
              placeholder="8.9 / 10"
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Role & Skills */}
      <section className="space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E4E0]">
          <Briefcase className="w-3.5 h-3.5 text-[#D97757]" />
          Experience & Skills
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className={labelClass}>Current Role / Title</label>
            <input
              type="text"
              value={draft.currentRole}
              onChange={(e) => updateField('currentRole', e.target.value)}
              placeholder="Full-Stack Developer"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Current Company / Org</label>
            <input
              type="text"
              value={draft.company}
              onChange={(e) => updateField('company', e.target.value)}
              placeholder="Independent / University"
              className={inputClass}
            />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>Skills (comma separated)</label>
            <input
              type="text"
              value={draft.skills}
              onChange={(e) => updateField('skills', e.target.value)}
              placeholder="React, TypeScript, Python, PyTorch, Node.js..."
              className={inputClass}
            />
          </div>
        </div>
      </section>

      {/* Rich Context for Open-Ended Form Questions */}
      <section className="space-y-2.5 pb-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#E5E4E0]">
          <FileText className="w-3.5 h-3.5 text-[#D97757]" />
          Bio, Projects & Custom Prompt Context
        </div>
        <div>
          <label className={labelClass}>Short Bio</label>
          <textarea
            rows={2}
            value={draft.shortBio}
            onChange={(e) => updateField('shortBio', e.target.value)}
            className={inputClass}
            placeholder="2-3 sentence summary about who you are..."
          />
        </div>
        <div>
          <label className={labelClass}>Key Projects (Used for "Tell us about a project" fields)</label>
          <textarea
            rows={3}
            value={draft.projectsSummary}
            onChange={(e) => updateField('projectsSummary', e.target.value)}
            className={inputClass}
            placeholder="Describe your top 2-3 projects and tech stack..."
          />
        </div>
        <div>
          <label className={labelClass}>Work Experience Summary</label>
          <textarea
            rows={3}
            value={draft.workExperience}
            onChange={(e) => updateField('workExperience', e.target.value)}
            className={inputClass}
            placeholder="Past internships, freelance work, or leadership roles..."
          />
        </div>
        <div>
          <label className={labelClass}>Custom Notes / Rules for the Agent</label>
          <textarea
            rows={2}
            value={draft.customNotes}
            onChange={(e) => updateField('customNotes', e.target.value)}
            className={inputClass}
            placeholder="Any custom instructions or default answers (e.g. T-shirt size: M, Dietary: Vegetarian)..."
          />
        </div>
      </section>
    </form>
  );
};

