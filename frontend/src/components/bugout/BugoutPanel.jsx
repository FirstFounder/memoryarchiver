import { useState, useEffect } from 'react';
import { BugoutProfilePage } from './BugoutProfilePage.jsx';
import { ALL_PROFILES, PROFILE_LABELS } from './bugoutProfiles.js';

function getDeepLinkProfile() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'bugoutprep' && parts[1] && ALL_PROFILES.includes(parts[1])) {
    return parts[1];
  }
  return null;
}

export function BugoutPanel() {
  const [activeProfile, setActiveProfile] = useState(() => getDeepLinkProfile());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {ALL_PROFILES.map(slug => (
          <button
            key={slug}
            onClick={() => setActiveProfile(slug)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeProfile === slug
                ? 'bg-indigo-700 text-white border border-indigo-500'
                : 'border border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            {PROFILE_LABELS[slug]}
          </button>
        ))}
      </div>

      {activeProfile && (
        <BugoutProfilePage key={activeProfile} profile={activeProfile} />
      )}
    </div>
  );
}
