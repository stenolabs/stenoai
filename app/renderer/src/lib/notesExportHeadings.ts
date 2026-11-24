// Keep export labels independent of the interface language and the stored
// Markdown headings. Covers the explicit summary languages in src/config.py.
const headings = {
  en: {
    summary: 'Summary',
    discussionAreas: 'Key Topics',
    keyPoints: 'Key Points',
    actionItems: 'Action Items',
    participants: 'Participants',
  },
  ar: {
    summary: 'الملخص',
    discussionAreas: 'المواضيع الرئيسية',
    keyPoints: 'النقاط الرئيسية',
    actionItems: 'المهام',
    participants: 'المشاركون',
  },
  de: {
    summary: 'Zusammenfassung',
    discussionAreas: 'Hauptthemen',
    keyPoints: 'Kernaussagen',
    actionItems: 'Aufgaben',
    participants: 'Teilnehmende',
  },
  es: {
    summary: 'Resumen',
    discussionAreas: 'Temas principales',
    keyPoints: 'Puntos clave',
    actionItems: 'Tareas',
    participants: 'Participantes',
  },
  fr: {
    summary: 'Résumé',
    discussionAreas: 'Sujets principaux',
    keyPoints: 'Points clés',
    actionItems: 'Actions à mener',
    participants: 'Participants',
  },
  he: {
    summary: 'סיכום',
    discussionAreas: 'נושאים מרכזיים',
    keyPoints: 'נקודות מרכזיות',
    actionItems: 'משימות',
    participants: 'משתתפים',
  },
  hi: {
    summary: 'सारांश',
    discussionAreas: 'मुख्य विषय',
    keyPoints: 'मुख्य बिंदु',
    actionItems: 'कार्य',
    participants: 'प्रतिभागी',
  },
  it: {
    summary: 'Riepilogo',
    discussionAreas: 'Argomenti principali',
    keyPoints: 'Punti chiave',
    actionItems: 'Attività da svolgere',
    participants: 'Partecipanti',
  },
  ja: {
    summary: '概要',
    discussionAreas: '主な議題',
    keyPoints: '要点',
    actionItems: '対応事項',
    participants: '参加者',
  },
  ko: {
    summary: '요약',
    discussionAreas: '주요 주제',
    keyPoints: '핵심 사항',
    actionItems: '실행 항목',
    participants: '참석자',
  },
  nl: {
    summary: 'Samenvatting',
    discussionAreas: 'Hoofdonderwerpen',
    keyPoints: 'Kernpunten',
    actionItems: 'Actiepunten',
    participants: 'Deelnemers',
  },
  pt: {
    summary: 'Resumo',
    discussionAreas: 'Temas principais',
    keyPoints: 'Pontos-chave',
    actionItems: 'Tarefas',
    participants: 'Participantes',
  },
  ru: {
    summary: 'Краткое содержание',
    discussionAreas: 'Основные темы',
    keyPoints: 'Ключевые моменты',
    actionItems: 'Задачи',
    participants: 'Участники',
  },
  'zh-Hans': {
    summary: '摘要',
    discussionAreas: '主要议题',
    keyPoints: '要点',
    actionItems: '待办事项',
    participants: '参与者',
  },
  'zh-Hant': {
    summary: '摘要',
    discussionAreas: '主要議題',
    keyPoints: '重點',
    actionItems: '待辦事項',
    participants: '參與者',
  },
};

function resolveHeadingLanguage(language?: string | null): keyof typeof headings {
  if (typeof language !== 'string' || !language.trim()) return 'en';

  try {
    const locale = new Intl.Locale(language.trim().replace(/_/g, '-'));
    if (locale.language === 'zh') {
      return locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
    }
    if (Object.hasOwn(headings, locale.language)) {
      return locale.language as keyof typeof headings;
    }
  } catch {
    // Older notes may contain a language value that is not a locale tag.
  }
  return 'en';
}

export function noteExportHeadings(outputLanguage?: string | null) {
  const language = resolveHeadingLanguage(outputLanguage);
  return { language, labels: headings[language] };
}
