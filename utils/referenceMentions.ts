const SIMPLE_REFERENCE_NAME_REGEX = /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/;

export const canUseSimpleMention = (referenceName: string) => {
  return SIMPLE_REFERENCE_NAME_REGEX.test(referenceName.trim());
};

export const formatReferenceMention = (referenceName: string) => {
  const trimmedName = referenceName.trim();
  return canUseSimpleMention(trimmedName) ? `@${trimmedName}` : `@{${trimmedName}}`;
};

export const formatProtectedReferenceMention = (referenceName: string) => {
  return formatReferenceMention(referenceName);
};

export const getReferenceMentionDisplayText = (mentionSyntaxOrName: string) => {
  if (mentionSyntaxOrName.startsWith('@{') && mentionSyntaxOrName.endsWith('}')) {
    return `@${mentionSyntaxOrName.slice(2, -1)}`;
  }

  if (mentionSyntaxOrName.startsWith('@')) {
    return mentionSyntaxOrName;
  }

  return `@${mentionSyntaxOrName.trim()}`;
};

export const normalizePromptReferenceMentions = (prompt: string, referenceNames: string[]) => {
  if (!prompt) return prompt;

  const sortedReferenceNames = [...referenceNames]
    .map(name => name.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  return prompt.replace(/@\{[^}]+\}|@([^\s@,，。.!！?？;；:：]+)/g, (matchedText) => {
    if (matchedText.startsWith('@{')) {
      return matchedText;
    }

    const token = matchedText.slice(1);
    const exactReferenceName = sortedReferenceNames.find(referenceName => referenceName === token);
    if (exactReferenceName) {
      return formatProtectedReferenceMention(exactReferenceName);
    }

    const prefixedReferenceName = sortedReferenceNames.find(referenceName => token.startsWith(referenceName));
    if (!prefixedReferenceName) {
      return matchedText;
    }

    const suffixText = token.slice(prefixedReferenceName.length);
    return `${formatProtectedReferenceMention(prefixedReferenceName)}${suffixText ? ` ${suffixText}` : ''}`;
  });
};

export const extractMentionNames = (prompt: string) => {
  const matches = prompt.matchAll(/@\{([^}]+)\}|@([^\s@,，。.!！?？;；:：]+)/g);
  const names: string[] = [];

  for (const match of matches) {
    const name = (match[1] || match[2] || '').trim();
    if (name) {
      names.push(name);
    }
  }

  return names;
};

export const removeReferenceMentions = (prompt: string) => {
  return prompt
    .replace(/@\{[^}]+\}|@([^\s@,，。.!！?？;；:：]+)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
};

export const replaceReferenceMention = (prompt: string, previousName: string, nextName: string) => {
  const escapedPreviousName = previousName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bracePattern = new RegExp(`@\\{${escapedPreviousName}\\}`, 'g');
  const nextMention = formatProtectedReferenceMention(nextName);

  let nextPrompt = prompt.replace(bracePattern, nextMention);

  if (canUseSimpleMention(previousName)) {
    const simplePattern = new RegExp(`@${escapedPreviousName}(?=[\\s@,，。.!！?？;；:：]|$)`, 'g');
    nextPrompt = nextPrompt.replace(simplePattern, nextMention);
  }

  return nextPrompt;
};
