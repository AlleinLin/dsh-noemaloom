/**
 * Russian dictionary for the "web-ui-plugins" locale namespace.
 * Source package: packages/dsh-web-settings (its zh dictionary is the key source).
 * Maintained centrally by the dsh-i18n language pack; when a zh key is added
 * or changed upstream, mirror it here and run `pnpm i18n:check`.
 */

export const ru: Record<string, string> = {
  'title': 'Веб-плагины',
  'telemetry.title': 'Анонимная телеметрия установок',
  'telemetry.description': 'Один анонимный сигнал в сутки о том, какие плагины семейства здесь используются',
  'telemetry.meta': 'Если выключить, браузерная часть всех плагинов семейства перестаёт отправлять данные; Мастерская и онлайн-обновления продолжают работать.',
  'telemetry.dnt': 'Браузер передаёт запрос Do Not Track, поэтому отправка сигналов уже остановлена; переключатель выше лишь сохраняет предпочтение на этой машине.',
  'settings.collapse': 'Свернуть',
  'settings.expand': 'Развернуть',
  'settings.notExposed': 'Раздел настроек недоступен (в хосте нет пространства имён).',
  'settings.unsaved': 'Есть несохранённые изменения',
  'settings.readOnly': 'Только чтение',
  'settings.saveFailed': 'Не удалось сохранить.',
  'settings.discard': 'Отменить изменения',
  'settings.save': 'Сохранить',
  'settings.saving': 'Сохранение…',
}
