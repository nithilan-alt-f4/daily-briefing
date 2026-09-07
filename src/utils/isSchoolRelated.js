/**
 * Detect if an event is school-related based on its title.
 * Used by both the API routes (Quick Notes) and calendar connector (moveSchoolEvents).
 */
export function isSchoolRelated(title) {
  const t = (title || '').toLowerCase();

  // Subject names (full + common abbreviations)
  const subjects = [
    'physics', 'phy', 'chemistry', 'chem', 'mathematics', 'maths', 'math',
    'biology', 'bio', 'english', 'eng', 'hindi', 'computer', 'computer science',
    'science', 'social studies', 'social', 'history', 'geography', 'economics',
    'civics', 'cs', 'it', 'accounts', 'business studies', 'bst',
    'political science', 'pol science', 'sanskrit', 'french', 'german',
    'spanish', 'pe', 'physical education'
  ];

  // School-related keywords
  const keywords = [
    'exam', 'test', 'practical', 'practicals', 'class', 'quiz', 'coaching',
    'aakash', 'akats', 'lecture', 'lesson', 'assignment', 'homework', 'project',
    'lab', 'viva', 'ptm', 'assembly', 'sports day', 'annual day', 'farewell',
    'bunk', 'period', 'timetable', 'schedule', 'tuition', 'internals',
    'semester', 'revision', 'pre-board', 'preboard', 'midterm', 'mid-term',
    'half yearly', 'annual exam', 'board exam', 'cbse', 'school'
  ];

  const hasSubject = subjects.some(s => t.includes(s));
  const hasKeyword = keywords.some(k => t.includes(k));
  return hasSubject || hasKeyword;
}
