/**
 * Russian dictionary for the "remote-bridge" locale namespace.
 * Source package: packages/dsh-remote-bridge (its zh dictionary is the key source).
 * Maintained centrally by the dsh-i18n language pack; when a zh key is added
 * or changed upstream, mirror it here and run `pnpm i18n:check`.
 */

export const ru: Record<string, string> = {
  'entry.label': 'Сопряжение телефона (протокол v1)',
  'title': 'Сопряжение по протоколу v1',
  'subtitle': 'Отсканируйте QR-код приложением на телефоне, чтобы сопрязить его с этим хостом по протоколу v1. Код выдаёт эта машина, и прочитать его можно только на ней.',
  'state.reading': 'Запрашиваю код сопряжения…',
  'pair.qrLabel': 'QR-код сопряжения',
  'pair.payloadLabel': 'Содержимое QR-кода (можно скопировать и вставить на телефоне)',
  'pair.countdown': 'Осталось {s} с',
  'pair.expired': 'Срок действия кода истёк (30 с)',
  'pair.expiredHint': 'Просроченный код телефон не примет — запросите новый.',
  'pair.usedHint': 'Код одноразовый: телефон расходует его в момент вызова pair.begin, а запрос нового кода аннулирует предыдущий.',
  'pair.refresh': 'Новый код',
  'origin.title': 'Публичный адрес определить не удалось, поэтому в QR-коде только сам код',
  'origin.body': 'У этой машины нет ни DSH_REMOTE_PUBLIC_BASE_URL, ни записи в реестре ретранслятора, поэтому адрес не попал в QR-код. Сначала укажите в приложении на телефоне публичный адрес ретранслятора (например, wss://<id>.dsh-market.com), затем сканируйте код выше; {host} (эта страница) доступен только с этой машины.',
  'origin.located.title': 'Телефон подключится к публичному ретранслятору напрямую (адрес уже в QR-коде)',
  'origin.located.body': 'В QR-коде уже есть {origin}: одно сканирование задаёт и адрес подключения, и код сопряжения — вводить ничего не нужно.',
  'forbidden.title': 'Эта страница открыта не на этой машине',
  'forbidden.body': 'Код сопряжения можно получить только на самой машине. Откройте http://127.0.0.1:<порт> в браузере на этой машине и повторите.',
  'failed.title': 'Не удалось получить код сопряжения',
  'failed.body': 'Хост ответил HTTP {status}. Перезагрузите страницу и повторите.',
  'unreachable.title': 'Не удаётся связаться с локальным хостом',
  'unreachable.body': 'Запрос не дошёл до хоста. Проверьте, что dsh web всё ещё запущен, и повторите.',
  'action.close': 'Закрыть',
  'action.copy': 'Скопировать код сопряжения',
  'action.copied': 'Скопировано',
  'action.copyFailed': 'Не удалось скопировать',
  'action.retry': 'Повторить',
}
