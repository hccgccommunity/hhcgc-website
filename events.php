<?php
/**
 * events.php — simple JSON-backed API for HCCGC events
 *
 * GET  events.php          -> returns all events as JSON array
 * POST events.php          -> body: JSON array of events, overwrites events.json
 *
 * This is intentionally simple (no database). events.json sits in the same
 * folder as this file and must be writable by the web server (chmod 664 is
 * usually enough; the containing folder may need to be writable too).
 */

header('Content-Type: application/json');

// Allow the request to come from your own site only.
// Update this if your admin page lives on a different subdomain.
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    // CORS preflight — nothing else to do
    http_response_code(204);
    exit;
}

$dataFile = __DIR__ . '/events.json';

function readEvents($file) {
    if (!file_exists($file)) {
        return [];
    }
    $raw = file_get_contents($file);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function isValidEvent($e) {
    if (!is_array($e)) return false;
    // fromTime is required; toTime, category, cost, imageUrl, rsvpUrl are optional
    $required = ['id', 'name', 'description', 'date', 'fromTime'];
    foreach ($required as $key) {
        if (!array_key_exists($key, $e)) return false;
    }
    if (!is_string($e['name']) || trim($e['name']) === '') return false;
    if (!is_string($e['date']) || trim($e['date']) === '') return false;
    if (!is_string($e['fromTime']) || trim($e['fromTime']) === '') return false;
    return true;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $events = readEvents($dataFile);

    // Sort by date ascending so the public page always shows soonest-first
    usort($events, function ($a, $b) {
        return strcmp($a['date'] ?? '', $b['date'] ?? '');
    });

    echo json_encode($events, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    exit;
}

if ($method === 'POST') {
    $input = file_get_contents('php://input');
    $events = json_decode($input, true);

    if (!is_array($events)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid payload — expected a JSON array of events.']);
        exit;
    }

    foreach ($events as $e) {
        if (!isValidEvent($e)) {
            http_response_code(400);
            echo json_encode(['error' => 'One or more events are missing required fields (name, description, date, fromTime).']);
            exit;
        }
    }

    $ok = file_put_contents($dataFile, json_encode($events, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

    if ($ok === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Could not write events.json. Check file/folder permissions on the server.']);
        exit;
    }

    echo json_encode(['success' => true, 'count' => count($events)]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed. Use GET or POST.']);
