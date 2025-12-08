# Observability Stack

Этот стек включает Prometheus для метрик, Loki для логов и Grafana для визуализации.

## Доступ к сервисам

- **Grafana**: http://localhost:3030 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Gateway**: http://localhost:3500

## Как посмотреть метрики в Grafana

1. Откройте Grafana: http://localhost:3030
2. Войдите (admin/admin)
3. Перейдите в **Dashboards** (иконка слева) → **Browse**
4. Вы увидите два дашборда:
   - **Microservices Metrics** - метрики Prometheus (HTTP запросы, latency, ошибки, память, CPU)
   - **Microservices Logs** - логи из Loki

### Что показывают метрики:

- **HTTP Request Rate** - количество запросов в секунду по сервисам
- **HTTP Request Duration (p95)** - 95-й перцентиль времени ответа
- **HTTP Status Codes** - распределение по статус-кодам (2xx, 4xx, 5xx)
- **Node.js Memory Usage** - использование памяти
- **CPU Usage** - использование CPU
- **Error Rate** - частота ошибок

## Как посмотреть логи в Grafana

### Способ 1: Готовый дашборд

1. Откройте дашборд **Microservices Logs**
2. Панель "Service Logs" показывает все логи всех сервисов
3. Панель "Error Logs" фильтрует только ошибки
4. Панель "Log Volume by Service" показывает объем логов по сервисам

### Способ 2: Explore (для детального поиска)

1. Откройте **Explore** (иконка компаса слева)
2. Выберите источник данных **Loki**
3. Введите запрос LogQL:

**Все логи:**
```
{container_name=~".*"}
```

**Логи конкретного сервиса (например, auth):**
```
{container_name=~".*auth.*"}
```

**Только ошибки:**
```
{container_name=~".*"} |= "error" |="Error" |="ERROR"
```

**Логи с определенным текстом:**
```
{container_name=~".*"} |= "payment"
```

**Логи по метке service:**
```
{service="auth"}
```

4. Нажмите **Run query**

### Полезные LogQL запросы:

- Все логи gateway: `{container_name=~".*gateway.*"}`
- Ошибки в payments: `{container_name=~".*payments.*"} |= "error"`
- Логи за последний час: `{container_name=~".*"} [1h]`
- Подсчет логов по сервисам: `sum(count_over_time({container_name=~".*"}[1m])) by (container_name)`

## Метрики доступны на эндпоинтах

Каждый сервис экспортирует метрики на `/metrics`:
- Gateway: http://localhost:3500/metrics
- Auth: http://localhost:3501/metrics
- Profile: http://localhost:3502/metrics
- Inventory: http://localhost:3504/metrics
- Orders: http://localhost:3505/metrics
- Payments: http://localhost:3506/metrics
- Shipping: http://localhost:3507/metrics
- Notifications: http://localhost:3508/metrics
- Images: http://localhost:3509/metrics
- Search: http://localhost:3510/metrics

## Prometheus запросы (PromQL)

В Grafana можно использовать PromQL запросы:

**Запросы в секунду:**
```
sum(rate(http_request_duration_seconds_count[5m])) by (service)
```

**Среднее время ответа:**
```
rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])
```

**95-й перцентиль:**
```
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))
```

**Ошибки (5xx):**
```
sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m])) by (service)
```

## Перезапуск после изменений

После изменений конфигурации перезапустите контейнеры:

```bash
docker compose restart grafana promtail prometheus loki
```

Или полностью пересоздайте:

```bash
docker compose down
docker compose up -d
```

