// SPDX-License-Identifier: LicenseRef-Proprietary

// Privacy policy of code-review.com: the marketing website (code-review.com) and the hosted application
// (app.code-review.com), including billing. German (binding) and English translation.
// Legal text drafted without a lawyer (October 2026). Have it reviewed by one before relying on it.
//
// Website (sections 3 to 7): static files delivered by Cloudflare Workers static assets (processor, USA,
// EU-US Data Privacy Framework, standard contractual clauses as fallback), consent with Klaro (cookie
// `code-review_klaro`), analytics with PostHog (EU cloud, the shared main project of Itegro GmbH for all its
// landing pages) after the visitor accepts (cookie, session replay, heatmaps, surveys, errors, rage and dead
// clicks; the visitor ID is passed on when following a link to itegro-gmbh.de or to app.code-review.com) or
// cookieless, pseudonymous counting after a decline or a privacy signal, through our own /ingest proxy on the
// Cloudflare Worker (which passes the request headers, with Referer and the visitor IP, on in both modes), no
// other third party content, contact by email. It describes what src/lib/consent.ts, src/lib/analytics.ts and
// worker/ingest.ts do; change it with them. The PostHog and Cloudflare settings this text relies on are listed in
// README.md ("Before launch").
//
// Application (sections 8 to 17): facts taken from the code and documentation of Itegro-GmbH/code-reviewer
// (Vercel in region fra1, Postgres at Neon in Europe Central, GitHub App, LLM providers, Stripe Managed Payments, Resend,
// Better Auth sessions). The points the owner has to confirm are listed in the pull request ("Bitte prüfen").
// The page shows no TODO markers.
// If the site or the application changes (analytics, embeds, forms, another host or processor), this text
// must change with it. The Markdown copies in legal/ are generated from this file
// (scripts/export-legal-markdown.mjs).
import type { LegalDocument } from "./legal-types";

export const PRIVACY_DATE = { de: "25. Oktober 2026", en: "25 October 2026" } as const;

const CONTROLLER_DE = [
  "Itegro GmbH, Buchberger Straße 10c, 82538 Geretsried, Deutschland",
  "Vertreten durch die Geschäftsführer Luca Schackmann, Lukas Laschinger und Vincent Helmers",
  "Telefon: +49 8171 908924-2, E-Mail: info@itegro-gmbh.de",
];

const CONTROLLER_EN = [
  "Itegro GmbH, Buchberger Straße 10c, 82538 Geretsried, Germany",
  "Represented by the managing directors Luca Schackmann, Lukas Laschinger and Vincent Helmers",
  "Phone: +49 8171 908924-2, email: info@itegro-gmbh.de",
];

export const PRIVACY_DE: LegalDocument = {
  lang: "de",
  title: "Datenschutzerklärung",
  dateLabel: `Stand: ${PRIVACY_DATE.de}`,
  sections: [
    {
      id: "de-verantwortlicher",
      heading: "1. Verantwortlicher",
      blocks: [
        "Verantwortlich für die Verarbeitung personenbezogener Daten auf der Website code-review.com und in der Anwendung unter app.code-review.com im Sinne der Datenschutz-Grundverordnung (DSGVO) ist:",
        { list: CONTROLLER_DE },
        "Soweit wir bei der Durchführung von Reviews Inhalte aus den Repositories unserer Kunden verarbeiten, handeln wir als Auftragsverarbeiter dieser Kunden (Abschnitt 8).",
        "Einen Datenschutzbeauftragten haben wir nicht benannt, da wir dazu gesetzlich nicht verpflichtet sind (Art. 37 DSGVO, § 38 BDSG).",
      ],
    },
    {
      id: "de-ueberblick",
      heading: "2. Überblick und Geltungsbereich",
      blocks: [
        "Diese Datenschutzerklärung gilt für zwei Angebote: für die Website code-review.com (Teil A, Abschnitte 3 bis 7) und für die Anwendung unter app.code-review.com, die gehostete Version von code-review.com (Teil B, Abschnitte 8 bis 17). Die Abschnitte 18 bis 21 gelten für beide.",
        "Die Website besteht aus statischen Dateien und dient der Information über code-review.com. Sie hat keine Formulare und keine Benutzerkonten. Personenbezogene Daten verarbeiten wir dort nur, soweit es für die Auslieferung der Website technisch nötig ist (Abschnitt 3), mit Ihrer Einwilligung für die Reichweitenmessung mit PostHog (einschließlich der Verknüpfung mit itegro-gmbh.de und der Übergabe an die Anwendung, Abschnitt 5) und ohne Einwilligung für die pseudonyme, cookiefreie Reichweitenmessung (Abschnitt 5) und wenn Sie uns per E-Mail schreiben (Abschnitt 6).",
        "In der Anwendung melden Sie sich mit Ihrem GitHub-Konto oder, soweit angeboten, mit E-Mail-Adresse und Passwort an, installieren unsere GitHub-App auf Repositories Ihrer Wahl und lassen Pull Requests von KI-Modellen prüfen. Dabei verarbeiten wir Kontodaten, GitHub-Daten, Inhalte der geprüften Repositories und Pull Requests, Nutzungs- und Abrechnungsdaten (Abschnitte 8 bis 17). Die Anwendung richtet sich an Unternehmen; wenn Sie als Beschäftigte oder Beschäftigter eines Kunden ein Konto nutzen, betrifft Sie diese Erklärung als Nutzer.",
      ],
    },
    {
      id: "de-hosting",
      heading: "3. Hosting bei Cloudflare und Server-Logdaten",
      blocks: [
        "Diese Website wird über Cloudflare Workers als statische Dateien ausgeliefert, einen Dienst der Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA. Cloudflare betreibt ein weltweites Netz von Rechenzentren (Content Delivery Network); Ihre Anfrage wird in der Regel von einem Rechenzentrum in Ihrer Nähe beantwortet. Cloudflare verarbeitet die Daten in unserem Auftrag. Der Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO (Cloudflare Data Processing Addendum) ist Teil der Nutzungsbedingungen von Cloudflare.",
        "Bei jedem Aufruf der Website sendet Ihr Browser automatisch Daten an Cloudflare. Cloudflare verarbeitet dabei insbesondere:",
        {
          list: [
            "die IP-Adresse des anfragenden Geräts",
            "Datum und Uhrzeit des Zugriffs",
            "die aufgerufene Adresse (URL) und die HTTP-Methode",
            "den HTTP-Statuscode",
            "die zuvor besuchte Seite (Referrer), sofern Ihr Browser sie übermittelt",
            "Browser und Betriebssystem (User Agent)",
            "weitere technische Angaben zur Verbindung und zur Anfrage, die Cloudflare auswertet, um Angriffe (etwa Überlastungsangriffe und schädliche Bots) abzuwehren und die Auslieferung schnell zu halten",
          ],
        },
        "Diese Daten werden verarbeitet, um die Website auszuliefern, ihre Sicherheit und Stabilität zu gewährleisten und Fehler zu analysieren. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; unser berechtigtes Interesse liegt in einer sicheren, schnellen und funktionsfähigen Bereitstellung der Website. Wir führen die Daten nicht mit anderen Daten zusammen, werten sie nicht zu Werbe- oder Analysezwecken aus und leiten sie nicht an Dritte weiter.",
        "Übermittlung in die USA: Cloudflare hat seinen Sitz in den USA, Daten können daher in die USA übermittelt werden. Cloudflare ist nach dem EU-US Data Privacy Framework zertifiziert; für zertifizierte Unternehmen besteht ein Angemessenheitsbeschluss der Europäischen Kommission (Art. 45 DSGVO). Für den Fall, dass diese Grundlage entfällt, enthält der Vertrag mit Cloudflare die Standardvertragsklauseln der Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO).",
        "Speicherdauer: Cloudflare speichert diese Daten nach eigenen Angaben nur so lange, wie es für diese Zwecke erforderlich ist. Eine Speicherung oder Weiterleitung von Zugriffsprotokollen für uns haben wir nicht eingerichtet. In unserem Cloudflare-Konto sehen wir zusammengefasste Statistiken, etwa die Zahl der Aufrufe, und Angaben zu einzelnen Anfragen nur dann, wenn Cloudflare sie als Angriff erkannt und blockiert hat.",
        "Cloudflare Web Analytics und andere Analysefunktionen von Cloudflare nutzen wir nicht. Die Anfragen der Reichweitenmessung (Abschnitt 5) laufen ebenfalls über Cloudflare und werden dabei wie jede andere Anfrage an diese Website behandelt.",
        "Die Verbindung zu dieser Website ist per TLS verschlüsselt (https).",
      ],
    },
    {
      id: "de-cookies",
      heading: "4. Cookies, Einwilligung und lokaler Speicher",
      blocks: [
        "Ohne Ihre Einwilligung setzt diese Website keine Cookies für Analysezwecke. Wir speichern dann nur Ihre Entscheidung im Einwilligungsdialog (Einwilligungsverwaltung „Klaro“, ein Werkzeug, das von unserer eigenen Domain aus läuft und keine Daten an Dritte sendet): In einem Cookie auf code-review.com (`code-review_klaro`, Laufzeit 180 Tage) legen wir ab, ob Sie der Reichweitenmessung zugestimmt oder sie abgelehnt haben. Das Cookie enthält keine Kennung und wird von uns nicht ausgewertet; Ihr Browser sendet es wie jedes Cookie mit den Anfragen an diese Website mit (Abschnitt 3). Es ist nach § 25 Abs. 2 Nr. 2 TDDDG unbedingt erforderlich, damit wir Ihre Wahl umsetzen können. Rechtsgrundlage für die Verarbeitung ist Art. 6 Abs. 1 lit. c i. V. m. Art. 7 Abs. 1 DSGVO sowie Art. 6 Abs. 1 lit. f DSGVO (Nachweis der Einwilligung). Nach Ablauf der 180 Tage fragen wir erneut. Eine Entscheidung aus dem früheren Dialog dieser Website (Eintrag `cr_consent` im lokalen Speicher) verwenden wir nicht mehr; Sie werden einmal neu gefragt, weil die Einwilligung jetzt weiter reicht (Abschnitt 5).",
        "Wenn Sie der Reichweitenmessung ausdrücklich zustimmen, kommen die in Abschnitt 5 beschriebenen Cookies und Speichereinträge von PostHog hinzu: ein Cookie auf code-review.com (`ph_…_posthog`, Laufzeit bis zu zwölf Monate) sowie Einträge in `localStorage` und `sessionStorage` (`ph_…`) mit einer zufälligen Kennung und Sitzungsdaten. Diese Technologien sind nicht unbedingt erforderlich; wir setzen sie nur mit Ihrer Einwilligung ein. Wenn Sie ablehnen oder Ihre Einwilligung widerrufen, werden sie gelöscht.",
        "Schriften, Bilder, Skripte und alle anderen Dateien kommen ausschließlich über unser Hosting bei Cloudflare (Abschnitt 3). Außer PostHog, und das nur mit Ihrer Einwilligung (Abschnitt 5), werden keine Inhalte anderer Anbieter geladen. Funktionen von Cloudflare, die Cookies setzen oder Skripte in die Website einfügen, haben wir nicht aktiviert. Die helle oder dunkle Darstellung folgt der Einstellung Ihres Systems, ohne dass dafür etwas gespeichert wird.",
      ],
    },
    {
      id: "analyse",
      heading: "5. Reichweitenmessung mit PostHog",
      blocks: [
        "Diese Website misst ihre Nutzung mit PostHog. Sie haben die Wahl, und „Accept“ und „Decline“ sind gleichwertig: Die Website funktioniert in beiden Fällen gleich. Solange Sie keine Wahl getroffen haben, wird PostHog nicht geladen, es wird keine Verbindung zu PostHog aufgebaut, es wird kein Cookie von PostHog gesetzt und nichts von PostHog auf Ihrem Endgerät gespeichert. Wählen Sie „Accept“, laden wir PostHog und messen ausführlicher (unten „Mit Einwilligung“). Wählen Sie „Decline“ oder sendet Ihr Browser das Signal „Global Privacy Control“ oder „Do Not Track“, zählen wir nur noch pseudonym und cookiefrei (unten „Pseudonyme Reichweitenmessung“); bei einem solchen Signal zeigen wir den Dialog nicht an, Sie können aber über den Link „Cookie settings“ im Fußbereich ausdrücklich zustimmen.",
        "Anbieter und Empfänger: PostHog Inc., 2261 Market Street #4008, San Francisco, CA 94114, USA. Wir nutzen PostHog Cloud EU; die Daten werden auf Servern in der Europäischen Union (Frankfurt) gespeichert. PostHog verarbeitet die Daten in unserem Auftrag auf Grundlage eines Auftragsverarbeitungsvertrags nach Art. 28 DSGVO. Weil PostHog Inc. ein US-amerikanisches Unternehmen ist, kann ein Zugriff aus den USA nicht ausgeschlossen werden. PostHog Inc. ist nach dem EU-US Data Privacy Framework zertifiziert; für zertifizierte Unternehmen besteht ein Angemessenheitsbeschluss der Europäischen Kommission (Art. 45 DSGVO). Zusätzlich enthält der Auftragsverarbeitungsvertrag die EU-Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO). Wir nutzen dafür das PostHog-Projekt, das die Itegro GmbH für alle ihre Websites gemeinsam betreibt (code-review.com und itegro-gmbh.de). Die Daten dieser Websites liegen also im selben Projekt und werden dort mit einer Kennzeichnung der jeweiligen Website unterschieden; Verantwortlich ist in beiden Fällen die Itegro GmbH.",
        "Weg der Anfragen: Ihr Browser sendet die Daten nicht direkt an PostHog, sondern an unsere eigene Domain (Adresse beginnend mit `/ingest`). Dort nimmt ein von uns betriebenes Skript auf Cloudflare Workers (Abschnitt 3) sie an und leitet sie an PostHog in der EU weiter. Das Skript speichert nichts. Es entfernt Cookies und Zugangsdaten (die Header „Cookie“ und „Authorization“) aus der Anfrage, gibt aber alle übrigen Angaben der Anfrage unverändert an PostHog weiter, die Ihr Browser und Cloudflare mitsenden, insbesondere die aufgerufene Seite (Header „Referer“), den User Agent, die Spracheinstellung und Ihre IP-Adresse. Die IP-Adresse geben wir in beiden Modi an PostHog weiter, damit PostHog eine ungefähre Herkunft bestimmen und in der pseudonymen Reichweitenmessung Besucher richtig zählen kann. PostHog speichert die IP-Adresse nicht mit den Ereignisdaten: In unserer PostHog-Organisation (EU-Cloud) ist die Speicherung der Client-IP („IP data capture“) ausgeschaltet. Wie genau die aus der IP-Adresse abgeleitete Herkunft gespeichert wird (Land, Region, Ort), richtet sich nach den Einstellungen unseres PostHog-Projekts.",
        "Mit Einwilligung: Wir verarbeiten die besuchten Seiten (Adresse und Titel), die Verweisquelle (Referrer), den Zeitpunkt und die Verweildauer, Browser, Betriebssystem, Gerätetyp, Bildschirmgröße, Sprache und Zeitzone, die ungefähre Herkunft, die PostHog aus der IP-Adresse ableitet (je nach Einstellung unseres PostHog-Projekts Land, Region und Ort), einzelne Klicks, Scrollbewegungen und Mausbewegungen (Autocapture und Heatmaps), wiederholte schnelle Klicks („Rage Clicks“) und Klicks ohne Wirkung („Dead Clicks“), Fehlermeldungen der Seite (Meldung und technischer Verlauf, ohne Eingaben), Ladezeiten der Seite und der Anfragen der Seite (Web Vitals und Netzwerkzeiten), kurze Umfragen zur Website und Aufzeichnungen einzelner Sitzungen (Session Replay). Die Sitzungsaufzeichnung erfasst den Seitenaufbau und die Bewegungen; alle Eingaben sind maskiert, sodass nicht sichtbar wird, was Sie eingeben. Eine zufällig erzeugte Kennung samt Sitzungskennung liegt in dem oben genannten Cookie und in `localStorage` und `sessionStorage` (`ph_…`); werden Umfragen angezeigt, merkt sich PostHog dort außerdem, welche Sie schon gesehen haben (`seenSurvey_…`, `inProgressSurvey_…`, `lastSeenSurveyDate`). Wir legen keine Personenprofile an und verknüpfen die Daten nicht mit Ihrem Namen oder Ihrer E-Mail-Adresse.",
        "Verknüpfung mit itegro-gmbh.de (nur mit Einwilligung): Wenn Sie in diesem Zustand einen Link von dieser Website zu itegro-gmbh.de anklicken, hängen wir die zufällige Besucherkennung und die Sitzungskennung aus Ihrem PostHog-Cookie sowie den aktuellen Zeitpunkt als Parameter (`ph_did`, `ph_sid`, `ph_ts`) an die Adresse an, und zwar nur in dem Moment, in dem Sie den Link öffnen (Klick, Strg- oder Cmd-Klick, Mittelklick, Enter). Der Link auf der Seite selbst bleibt ohne Parameter; wenn Sie ihn kopieren oder ziehen, geben Sie keine Kennung weiter. itegro-gmbh.de, ebenfalls eine Website der Itegro GmbH im selben PostHog-Projekt, entfernt die Parameter sofort aus der Adresse. Haben Sie dort ebenfalls eingewilligt und ist der Link höchstens zwei Minuten alt, erkennt PostHog Sie als denselben Besucher in derselben Sitzung wieder; andernfalls (auch bei älteren Links und ungültigen Werten) werden die Kennungen verworfen. Trägt ein Link von itegro-gmbh.de zu dieser Website solche Parameter, behandelt diese Website sie genauso: Haben Sie hier eingewilligt und ist der Link höchstens zwei Minuten alt, übernimmt PostHog die Kennungen, andernfalls werden sie verworfen; die Parameter werden in jedem Fall sofort aus der Adresse entfernt. Ohne Ihre Einwilligung auf der jeweiligen Website werden keine Kennungen angehängt oder übernommen. Ihre Einwilligung gilt je Website; auf der Zielseite werden Sie also gegebenenfalls erneut gefragt.",
        "Übergabe an die Anwendung (nur mit Einwilligung): Klicken Sie in diesem Zustand auf einen Link zur Anwendung unter app.code-review.com (Registrieren oder Anmelden), hängen wir ebenfalls die Besucherkennung, die Sitzungskennung und den Zeitpunkt als Parameter (`ph_did`, `ph_sid`, `ph_ts`) an die Adresse an, wiederum nur in dem Moment, in dem Sie den Link öffnen, und wir erfassen den Klick als Ereignis (`cta_clicked`, mit der Art des Links und der Stelle auf der Seite). Die Anwendung nimmt die gültigen Kennungen (nicht den Zeitpunkt) beim Aufruf der Seite zum Registrieren oder Anmelden in einem kurzlebigen Cookie (`__Host-cr-landing`, Abschnitt 10) entgegen und entfernt die Parameter aus der Adresse. Bei der Registrierung oder bei der ersten Anmeldung speichert sie die gültigen Kennungen zusammen mit Ihrem Benutzerkonto, solange dazu noch keine gespeichert sind, um die Registrierung dem Besuch dieser Website zuzuordnen (Zuordnung der Herkunft von Registrierungen); bereits gespeicherte Kennungen werden nicht ersetzt. Die Kennungen werden mit dem Konto gelöscht (Abschnitt 17). Ohne Ihre Einwilligung, in der pseudonymen Reichweitenmessung und bei einem Datenschutzsignal wird nichts angehängt, und die Anwendung erhält keine Kennung.",
        "Zweck und Rechtsgrundlage (mit Einwilligung): Zweck ist die statistische Auswertung der Nutzung, um Inhalte, Aufbau und Bedienung der Website zu verbessern und Fehler zu finden, sowie nachzuvollziehen, welche Besuche dieser Website zu einer Registrierung führen. Rechtsgrundlage ist Ihre Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO und § 25 Abs. 1 TDDDG, die auch das Auslesen der Kennung für die Übergabe an itegro-gmbh.de und die Anwendung umfasst. Sie können die Einwilligung jederzeit widerrufen.",
        "Pseudonyme Reichweitenmessung (ohne Einwilligung): Wenn Sie „Decline“ wählen oder ein Datenschutzsignal senden, zählen wir nur, wie oft Seiten aufgerufen und verlassen werden. PostHog läuft dann im cookiefreien Modus: Es wird kein Cookie gesetzt und nichts in `localStorage` oder `sessionStorage` gespeichert. Das Skript liest dafür aus Ihrem Browser nur die Angaben aus, die es mit dem Seitenaufruf an PostHog sendet: die aufgerufene Adresse und den Seitentitel, die Verweisquelle (Referrer), Browser samt Version, Betriebssystem, Gerätetyp, Bildschirm- und Fenstergröße, Spracheinstellung und Zeitzone sowie beim Verlassen der Seite die Verweildauer und die Scrolltiefe; dazu kommt die Kennzeichnung der Website. Aus IP-Adresse, Browserkennung (User Agent) und einem täglich wechselnden Zufallswert bildet PostHog auf seinen Servern eine Kennung, die keine Zuordnung über mehrere Tage erlaubt und die wir nicht mit Ihrer Person zusammenführen. Weil die IP-Adresse in diese Kennung einfließt, sind diese Daten pseudonym, nicht anonym. Sitzungsaufzeichnungen, Heatmaps, Umfragen, Fehlererfassung und Autocapture sind in diesem Modus ausgeschaltet, ebenso das Anhängen von Kennungen an Links. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; unser berechtigtes Interesse liegt in einer datensparsamen Reichweitenmessung. Da dabei nichts auf Ihrem Endgerät gespeichert wird und nur die genannten technischen Angaben ausgelesen werden, die nicht dazu dienen, Sie auf Ihrem Gerät wiederzuerkennen, greift nach unserer Auffassung die Einwilligungspflicht des § 25 Abs. 1 TDDDG nicht.",
        "Speicherdauer: Wie lange PostHog Sitzungsaufzeichnungen aufbewahrt, stellen wir in den Einstellungen unseres PostHog-Projekts ein (derzeit 30 Tage); danach werden sie gelöscht. Ereignisdaten (Seitenaufrufe, Klicks, Fehler und Ähnliches) speichern wir nur so lange, wie es für die Auswertung erforderlich ist, und löschen sie danach. Das Cookie `ph_…_posthog` und die Einträge in Ihrem Browser bleiben, bis Sie sie löschen oder Ihre Einwilligung widerrufen, höchstens zwölf Monate; das Cookie des Einwilligungsdialogs gilt 180 Tage. Danach fragen wir erneut.",
        "Widerruf: Sie können Ihre Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen, über den Link „Cookie settings“ im Fußbereich jeder Seite. Die Seite löscht dann die PostHog-Cookies und die PostHog-Einträge in Ihrem Browser, lädt sich neu und wechselt in die pseudonyme, cookiefreie Messung. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt. Bereits erhobene Daten löschen wir auf Anfrage, soweit wir sie Ihnen zuordnen können; dafür benötigen wir die Kennung aus Ihrem Browser. Bereits an die Anwendung übergebene Kennungen löschen wir auf Anfrage zusammen mit Ihrem Konto oder auf Wunsch vorab (Abschnitt 17).",
      ],
    },
    {
      id: "de-kontakt",
      heading: "6. Kontakt per E-Mail",
      blocks: [
        "Wenn Sie uns per E-Mail schreiben, verarbeiten wir Ihre E-Mail-Adresse, Ihren Namen, sofern Sie ihn angeben, und den Inhalt Ihrer Nachricht, um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO, wenn Ihre Anfrage mit einem Vertrag oder dessen Anbahnung zusammenhängt, und im Übrigen Art. 6 Abs. 1 lit. f DSGVO; unser berechtigtes Interesse liegt darin, Anfragen zu beantworten.",
        "Ihre E-Mails werden bei unserem E-Mail-Anbieter gespeichert, der sie in unserem Auftrag verarbeitet (Art. 28 DSGVO). Wir löschen die Daten, sobald Ihre Anfrage erledigt ist, es sei denn, gesetzliche Aufbewahrungspflichten stehen dem entgegen; Geschäftsbriefe bewahren wir nach § 257 HGB und § 147 AO sechs Jahre auf.",
      ],
    },
    {
      id: "de-links",
      heading: "7. Links zu anderen Websites",
      blocks: [
        "Diese Website enthält Links zu GitHub (GitHub, Inc., USA), zu itegro-gmbh.de (Website der Itegro GmbH) und zur Anwendung unter app.code-review.com. Es handelt sich um einfache Links: Solange Sie keinen davon anklicken, werden keine Daten an diese Anbieter übertragen. Klicken Sie einen Link an, rufen Sie die andere Website auf; dann gelten deren Datenschutzbestimmungen. Haben Sie in die Reichweitenmessung eingewilligt, hängen wir bei den Links zu itegro-gmbh.de und zur Anwendung Kennungen an (Abschnitt 5).",
      ],
    },
    {
      id: "de-rollen",
      heading: "8. Unsere Rolle in der Anwendung",
      blocks: [
        "Wir sind Verantwortlicher für die Daten, die wir für Ihr Konto, die Anmeldung, die Abrechnung, die Sicherheit und den Betrieb der Anwendung verarbeiten (Abschnitte 10, 14 bis 17).",
        "Wir sind Auftragsverarbeiter, soweit wir bei der Durchführung von Reviews Inhalte der Repositories und Pull Requests unserer Kunden verarbeiten (Abschnitte 11 und 12). Verantwortlicher ist dann der Kunde, also das Unternehmen, das den Workspace betreibt. Mit ihm schließen wir einen Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO; er ist Teil unserer Allgemeinen Geschäftsbedingungen (code-review.com/terms/). Dritte, deren Daten in einem Repository vorkommen (zum Beispiel Autoren von Commits), wenden sich bitte zunächst an das Unternehmen, dessen Repository betroffen ist; wir unterstützen dieses bei der Beantwortung.",
      ],
    },
    {
      id: "de-hosting-app",
      heading: "9. Hosting und Infrastruktur der Anwendung",
      blocks: [
        "Anwendung und Review-Infrastruktur: Die Anwendung, der Dispatcher (der Dienst, der für jeden Review eine Recheneinheit startet) und die virtuellen Maschinen, in denen die Reviews laufen (Vercel Sandbox), werden bei Vercel Inc., USA, betrieben, und zwar in der Region Frankfurt am Main (fra1) in der Europäischen Union. Die Anwendung läuft nicht über Cloudflare; Cloudflare liefert nur die Website aus (Abschnitt 3). Vercel verarbeitet die Daten in unserem Auftrag auf Grundlage eines Vertrags zur Auftragsverarbeitung nach Art. 28 DSGVO. Beim Aufruf der Anwendung verarbeitet Vercel technisch notwendige Verbindungsdaten wie IP-Adresse, Zeitpunkt, aufgerufene Adresse, Statuscode und User Agent, um die Anwendung auszuliefern und abzusichern. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung der Anwendung für Kunden und ihre Nutzer) und Art. 6 Abs. 1 lit. f DSGVO (sicherer und stabiler Betrieb).",
        "Datenbank: Die Daten der Anwendung (Konten, Workspaces, Einstellungen, verschlüsselte Schlüssel, Angaben zu Reviews, Buchungsjournal) liegen in einer verwalteten PostgreSQL-Datenbank bei Neon, Inc., USA. Die Datenbank wird in der Region Europe Central (AWS eu-central-1, Frankfurt am Main) betrieben; die Daten werden also in der Europäischen Union gespeichert. Die Verbindung ist per TLS verschlüsselt. Neon verarbeitet die Daten in unserem Auftrag auf Grundlage eines Vertrags zur Auftragsverarbeitung nach Art. 28 DSGVO.",
        "Übermittlung in die USA: Vercel und Neon haben ihren Sitz beziehungsweise ihre Muttergesellschaft in den USA; ein Zugriff aus den USA kann trotz Speicherung in der EU nicht ausgeschlossen werden. Wir stützen die Übermittlung auf den Angemessenheitsbeschluss der Europäischen Kommission zum EU-US Data Privacy Framework (Art. 45 DSGVO), soweit der Empfänger danach zertifiziert ist, und im Übrigen auf die Standardvertragsklauseln der Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO).",
      ],
    },
    {
      id: "de-konto",
      heading: "10. Konto, Anmeldung und Sitzungen",
      blocks: [
        "Anmeldung mit GitHub: GitHub übermittelt uns nach Ihrer Zustimmung Ihre GitHub-Kennung, Ihren Login-Namen, Ihren Namen, die Adresse Ihres Profilbilds und Ihre bei GitHub verifizierte primäre E-Mail-Adresse. Die Anmeldung gibt uns keinen Zugriff auf Ihre Repositories; Zugriff entsteht erst, wenn ein Kunde unsere GitHub-App auf Repositories installiert (Abschnitt 11). Das von GitHub ausgestellte Zugriffstoken speichern wir verschlüsselt.",
        "Anmeldung mit E-Mail-Adresse und Passwort (soweit angeboten): Wir speichern Ihre E-Mail-Adresse, Ihren Namen und eine Prüfsumme (Hash) Ihres Passworts, nie das Passwort selbst. Für die Bestätigung der Adresse und für das Zurücksetzen des Passworts erzeugen wir Links, von denen wir nur einen Hash speichern.",
        "Workspaces und Rollen: Ein Workspace gehört einem Kunden. Wir speichern, wer Mitglied ist, mit welcher Rolle (Owner, Admin oder Member) und welche Einladungen offen sind (E-Mail-Adresse der eingeladenen Person, einladende Person). Die Mitglieder eines Workspace sehen Namen, E-Mail-Adresse und Rolle der anderen Mitglieder.",
        "Sitzungen und Sicherheit: Nach der Anmeldung speichern wir eine Sitzung mit Kennung, Ablaufzeit (30 Tage), IP-Adresse und User Agent. Zusätzlich zählen wir Anmeldeversuche und andere Anfragen je Adresse, Link oder Konto (als Hash), um Missbrauch und Angriffe abzuwehren.",
        "Cookies und lokaler Speicher in der Anwendung: Die Anwendung setzt ein Sitzungscookie, das Sie angemeldet hält (nur über https, bis zu 30 Tage), sowie kurzlebige Cookies für den Ablauf der Anmeldung mit GitHub. Zusätzlich speichert sie Ihre Einstellung zur Seitenleiste in einem Cookie (`sidebar_state`, sieben Tage) und, wenn Sie hell oder dunkel fest wählen, diese Wahl im lokalen Speicher Ihres Browsers (`code-reviewer-theme`, ohne Kennung). Diese Zugriffe sind nach § 25 Abs. 2 Nr. 2 TDDDG erforderlich, damit wir die von Ihnen gewünschte Anwendung bereitstellen können; eine Einwilligung ist dafür nicht nötig. Davon ausgenommen ist das Cookie `__Host-cr-landing`, das nur nach einem Link von der Website mit Ihrer Einwilligung gesetzt wird (nächster Absatz). Analyse-, Werbe- oder Tracking-Dienste setzen wir in der Anwendung nicht ein.",
        "Herkunft der Registrierung (nur mit Einwilligung): Haben Sie auf der Website code-review.com der Reichweitenmessung zugestimmt und gelangen von dort zur Registrierung oder Anmeldung, übergibt die Website die Besucherkennung und die Sitzungskennung von PostHog (Parameter `ph_did` und `ph_sid`, Abschnitt 5). Beim Aufruf der Seite legt die Anwendung die gültigen Kennungen in einem Cookie ab (`__Host-cr-landing`, nur auf app.code-review.com, HttpOnly, Secure, eine Stunde gültig; ist nur eine der beiden Kennungen gültig, wird nur diese abgelegt) und entfernt die Parameter aus der Adresse. Das Cookie sorgt nur dafür, dass die Kennungen die Anmeldung, die Weiterleitung zu GitHub und den Rückweg überstehen; kein Skript kann es lesen, und es wird bei der ersten Registrierung oder Anmeldung, die es sieht, gelöscht. Beim ersten Aufruf stehen die Kennungen allerdings noch in der Adresse und können deshalb in den Anfrageprotokollen des Hosting-Anbieters der Anwendung (Abschnitt 9) für deren übliche Aufbewahrungsdauer erscheinen. Bei der Registrierung oder bei der ersten Anmeldung speichern wir die gültigen Kennungen mit Ihrem Konto, solange dazu noch keine gespeichert sind (bereits gespeicherte werden nicht ersetzt), um die Registrierung dem Besuch der Website zuzuordnen. Die Anwendung lädt dafür kein PostHog und sendet die Kennungen nicht an PostHog. Sie werden für die Nutzung der Anwendung nicht benötigt, und ohne Ihre Einwilligung auf der Website werden sie nicht übergeben. Rechtsgrundlage ist Ihre Einwilligung auf der Website (Art. 6 Abs. 1 lit. a DSGVO, § 25 Abs. 1 TDDDG).",
        "Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, soweit Sie selbst Vertragspartner sind oder der Vertrag mit Ihrem Arbeitgeber die Nutzung durch Sie vorsieht; im Übrigen Art. 6 Abs. 1 lit. f DSGVO (Bereitstellung der Anwendung für Beschäftigte unserer Kunden, Sicherheit und Missbrauchsabwehr).",
      ],
    },
    {
      id: "de-github",
      heading: "11. Die GitHub-App und Ihre Repositories",
      blocks: [
        "Ein Kunde installiert unsere GitHub-App auf den Repositories, die geprüft werden sollen. Die App erhält von GitHub die Berechtigungen: Pull Requests (lesen und schreiben), Issues (lesen und schreiben, für Kommentare und Reaktionen auf Pull Requests), Contents (nur lesen), Metadata (nur lesen) und Checks (lesen und schreiben, für die Statusanzeige am Pull Request), außerdem als Kontoberechtigung das Lesen von E-Mail-Adressen (für die Anmeldung) und als Organisationsberechtigung das Lesen von Mitgliedschaften (um Ihre Rolle bei der Verknüpfung einer Organisation zu prüfen). Wir schreiben keinen Code in Ihre Repositories.",
        "GitHub meldet uns per Webhook Ereignisse zu Pull Requests und Kommentaren. Wir verarbeiten daraus die Installation, das Konto oder die Organisation, die Repositories (Name und Kennung), die Nummer und den Stand des Pull Requests, den aktuellen Commit und den Login der Person, die einen Review auslöst (zum Beispiel durch den Kommentar `/review`), einschließlich der Angabe, ob sie Schreibrechte hat. Für jeden Review erzeugen wir ein kurzlebiges Zugriffstoken von GitHub, das nur für das eine Repository dieses Reviews gilt. Die Ergebnisse eines Reviews veröffentlichen wir als Kommentare, Reaktionen und Check Run am Pull Request, also in Ihrem Repository bei GitHub.",
        "GitHub (GitHub, Inc., USA) ist dabei ein eigener Verantwortlicher; für die Verarbeitung durch GitHub gilt dessen Datenschutzerklärung. Rechtsgrundlage unserer Verarbeitung ist Art. 6 Abs. 1 lit. b DSGVO; soweit wir als Auftragsverarbeiter handeln, Abschnitt 8.",
      ],
    },
    {
      id: "de-reviews",
      heading: "12. Durchführung von Reviews und Weitergabe an KI-Anbieter",
      blocks: [
        "Ablauf: Löst ein Pull Request oder ein Kommentar einen Review aus, legen wir einen Auftrag an. Für ihn startet der Dispatcher eine frische, nicht dauerhafte virtuelle Maschine in der Region Frankfurt am Main (Vercel Sandbox), die aus einem Abbild ohne Kundendaten erzeugt wird. Darin liest ein Programm (der Worker) über das kurzlebige GitHub-Token die Änderungen des Pull Requests (Diff Review) oder, beim Dynamic Review, das Repository nur lesend, einschließlich Regeldateien wie `AGENTS.md`, und fragt ein KI-Modell. Das Ergebnis wird am Pull Request veröffentlicht. Nach dem Review wird die virtuelle Maschine beendet; sie enthält keine dauerhafte Kopie.",
        "Weitergabe an den KI-Anbieter: Für die Anfrage an das Modell übermitteln wir Auszüge Ihres Codes und Ihrer Pull Requests, insbesondere die geänderten Zeilen, Dateiinhalte, Dateinamen, Titel, Beschreibung und Kommentare des Pull Requests, Angaben zu Commits (zum Beispiel Autorennamen) und Anweisungen, die Sie für das Projekt hinterlegt haben. Diese Inhalte können personenbezogene Daten enthalten.",
        "Welcher Anbieter: Nutzt der Workspace die verwalteten Modelle, setzen wir die von uns beauftragten Anbieter ein; derzeit sind das Anthropic PBC, USA, und, soweit eingerichtet, OpenRouter, Inc., USA. Mit ihnen haben wir einen gewerblichen Zugang (API) vereinbart; soweit vorgesehen, gelten deren Bedingungen zur Auftragsverarbeitung. Nutzt der Workspace einen eigenen Schlüssel, geht die Anfrage an den Anbieter, den der Kunde aus dem Modellkatalog gewählt hat und mit dem der Kunde einen eigenen Vertrag hat; wir übermitteln die Inhalte dann im Auftrag und nach Weisung des Kunden. Welche Daten ein Modellanbieter wie lange speichert oder für eigene Zwecke verwendet, richtet sich nach den Bedingungen dieses Anbieters. Wir selbst verwenden die Inhalte Ihrer Repositories und die Antworten der Modelle nicht, um Modelle zu trainieren, und geben sie dafür nicht an Dritte weiter.",
        "Was bei uns gespeichert bleibt: Zu jedem Review speichern wir Metadaten (Repository, Nummer des Pull Requests, Commit, Auslöser, Status, Zeiten, Fehlercode), den Link zum Kommentar, die Zahl der offenen Befunde nach Schweregrad, einen technischen Protokollauszug von höchstens 8.192 Zeichen, in dem Zugangsdaten unkenntlich gemacht sind und der im Einzelfall Dateipfade oder kurze Textauszüge enthalten kann, sowie Nutzungsdaten (Tokenzahlen, Kosten, Laufzeit, bei Dynamic Reviews eine Aufstellung technischer Aufrufe mit Zahlen und Namen, ohne Inhalte). Quellcode speichern wir nicht dauerhaft; den Text der Reviews finden Sie am Pull Request bei GitHub.",
        "Rechtsgrundlage: Wir verarbeiten die Inhalte als Auftragsverarbeiter im Auftrag des Kunden (Abschnitt 8). Die Metadaten und Nutzungsdaten verarbeiten wir als Verantwortlicher auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO (Erbringung und Abrechnung des Dienstes) und Art. 6 Abs. 1 lit. f DSGVO (Betrieb, Fehleranalyse, Sicherheit).",
        "Übermittlung in die USA: Die genannten KI-Anbieter haben ihren Sitz in den USA. Die Übermittlung stützen wir auf die Standardvertragsklauseln der Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO), die Teil der Vertragsbedingungen des jeweiligen Anbieters sind, oder, soweit der Anbieter zertifiziert ist, auf den Angemessenheitsbeschluss zum EU-US Data Privacy Framework (Art. 45 DSGVO). Bei einem eigenen Schlüssel regelt der Kunde die Übermittlung in seinem Vertrag mit dem Anbieter.",
      ],
    },
    {
      id: "de-schluessel",
      heading: "13. Eigene Schlüssel und Modellkatalog",
      blocks: [
        "Ein Kunde kann für seinen Workspace eigene API-Schlüssel von KI-Anbietern hinterlegen. Wir speichern sie verschlüsselt, zeigen sie nach dem Speichern nicht mehr an und verwenden sie nur für Reviews dieses Workspace. Für einen Review geben wir den Schlüssel an den Worker weiter; eine verschlüsselte Kopie bleibt höchstens sieben Tage nach Ende des Auftrags erhalten, damit der Schlüssel auch bei einer verspäteten Meldung in Ergebnissen unkenntlich gemacht werden kann. Hinterlegte Schlüssel löschen wir, wenn Sie sie entfernen oder der Workspace gelöscht wird.",
        "Das Verzeichnis der verfügbaren Anbieter und Modelle (Namen, Preise, Kontextgrößen) laden wir täglich von dem öffentlichen Katalog models.dev. Dabei werden keine Daten von Nutzern oder Kunden übertragen; models.dev sieht lediglich die Verbindungsdaten unseres Servers.",
      ],
    },
    {
      id: "de-zahlung",
      heading: "14. Abrechnung, Guthaben und Zahlungen",
      blocks: [
        "Die Anwendung wird mit vorausbezahltem Guthaben pro Workspace abgerechnet (Näheres in den AGB). Guthaben können Owner und Admins eines Workspace aufladen. Die Zahlung läuft über Stripe Managed Payments: Merchant of Record und Zahlungsabwickler ist dabei Stripe (Sold through Link, LLC und weitere Gesellschaften der Stripe-Gruppe, im Bezahlvorgang als „Sold through Link“ angezeigt). Stripe erhebt die Zahlungsdaten (zum Beispiel Karten- oder Bankdaten), stellt Zahlungsbelege und Rechnungen aus und kümmert sich um Umsatzsteuer, Betrugsabwehr und Zahlungsanfechtungen. Stripe ist dafür ein eigener Verantwortlicher; es gelten die Datenschutzbestimmungen von Stripe (stripe.com/privacy). Wir erhalten keine Karten- oder Bankdaten, sondern den Status der Zahlung, den Betrag und Referenzkennungen.",
        "Abrechnungsangaben: Vor der ersten Aufladung erfassen wir je Workspace Ihren Firmennamen, Ihre Anschrift und optional Ihre Umsatzsteuer-Identifikationsnummer sowie Ihre Bestätigung, dass Sie als Unternehmen kaufen (mit Zeitpunkt, handelnder Person und Version der AGB). Diese Angaben sehen nur Owner und Admins des Workspace. Wir übermitteln sie an Stripe, damit Beleg und Rechnung auf Ihr Unternehmen ausgestellt werden können, und schreiben sie nicht in Protokolle.",
        "Buchungsjournal: Für jeden Workspace führen wir ein Journal aller Bewegungen: Aufladungen, Startguthaben, Abbuchungen je Review (aufgeteilt in KI-Anteil und Infrastrukturanteil), Erstattungen, Rückbuchungen und Korrekturen, jeweils mit Datum und Referenzkennungen von Stripe. Das Journal ist unveränderlich und für alle Mitglieder des Workspace sichtbar. Stripe löscht seine Datensätze auf Anfrage von Käufern; das Journal enthält nur unsere Beträge und Kennungen.",
        "Missbrauchsschutz: Das Startguthaben gewähren wir einmal je GitHub-Konto. Dazu speichern wir die Kennung des GitHub-Kontos der Installation, auch über die Löschung eines Workspace hinaus. Außerdem begrenzen wir die Zahl der Reviews je Zeitraum und setzen auf Wunsch des Kunden ein monatliches Ausgabenlimit um. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (Schutz vor Missbrauch des Startguthabens und der Infrastruktur).",
        "Rechtsgrundlagen: Art. 6 Abs. 1 lit. b DSGVO (Aufladung, Abrechnung), Art. 6 Abs. 1 lit. c DSGVO in Verbindung mit § 257 HGB und § 147 AO (handels- und steuerrechtliche Aufbewahrung) sowie Art. 6 Abs. 1 lit. f DSGVO (Missbrauchsschutz, Durchsetzung von Ansprüchen).",
        "Übermittlung in die USA: Stripe verarbeitet Zahlungsdaten durch Gesellschaften der Stripe-Gruppe, auch in den USA, auf Grundlage seiner eigenen Garantien (Angemessenheitsbeschluss zum EU-US Data Privacy Framework, soweit zertifiziert, sonst Standardvertragsklauseln).",
      ],
    },
    {
      id: "de-mails",
      heading: "15. E-Mails der Anwendung",
      blocks: [
        "Die Anwendung verschickt E-Mails für die Bestätigung von E-Mail-Adressen, das Zurücksetzen von Passwörtern, Einladungen in einen Workspace und Hinweise an Owner und Admins, wenn das Guthaben niedrig oder aufgebraucht ist. Dafür verarbeiten wir die E-Mail-Adresse, den Namen und den Inhalt der Nachricht (zum Beispiel einen Link oder den Namen des Workspace). Der Versand erfolgt über den E-Mail-Dienst Resend der Resend, Inc., USA, der die Daten in unserem Auftrag verarbeitet (Art. 28 DSGVO); die Verbindung ist verschlüsselt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO und, für Sicherheits-E-Mails, Art. 6 Abs. 1 lit. f DSGVO. Übermittlung in die USA: Wir stützen die Übermittlung an Resend auf den Angemessenheitsbeschluss der Europäischen Kommission zum EU-US Data Privacy Framework (Art. 45 DSGVO), soweit Resend danach zertifiziert ist, und im Übrigen auf die Standardvertragsklauseln der Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO).",
      ],
    },
    {
      id: "de-protokolle",
      heading: "16. Protokolle und Fehlersuche",
      blocks: [
        "Für den Betrieb führen wir Betriebsprotokolle (bei Vercel). Sie enthalten Kennungen und Fehlercodes, aber keine Inhalte von Repositories, keine Anfrage- oder Antwortinhalte, keine Zugangsdaten und keine Abrechnungsangaben. Vercel speichert diese Protokolle nur für kurze Zeit nach seinen Vorgaben. Zweck ist der stabile und sichere Betrieb, die Fehleranalyse und die Aufklärung von Missbrauch; Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Dienste zur Fehlerüberwachung oder Nutzungsanalyse von Drittanbietern setzen wir in der Anwendung nicht ein.",
      ],
    },
    {
      id: "de-speicherdauer",
      heading: "17. Speicherdauer und Löschung",
      blocks: [
        "Wir speichern personenbezogene Daten in der Anwendung nur so lange, wie es für den jeweiligen Zweck nötig ist:",
        {
          list: [
            "Konto, Mitgliedschaften und Einstellungen: bis zur Löschung des Kontos oder des Workspace",
            "nicht bestätigte Registrierungen mit E-Mail-Adresse und Passwort: sieben Tage nach der Registrierung",
            "Links zur Bestätigung und zum Zurücksetzen: 24 Stunden beziehungsweise 30 Minuten gültig, danach höchstens sieben Tage aufbewahrt",
            "Sitzungen: 30 Tage gültig; die Datensätze bleiben bis zur Löschung des Kontos gespeichert",
            "Kennungen zur Herkunft der Registrierung (PostHog-Besucher- und Sitzungskennung, nur mit Einwilligung auf der Website): bis zur Löschung des Kontos",
            "Zähler gegen Missbrauch: höchstens 24 Stunden",
            "Verschlüsselte Kopie eines Schlüssels für einen Auftrag: bis zu sieben Tage nach Ende des Auftrags; hinterlegte Schlüssel: bis Sie sie entfernen",
            "technische Angaben zur Übergabe eines Auftrags an den Dispatcher: sieben Tage nach Ende des Auftrags",
            "Angaben zu Reviews, Protokollauszüge und Nutzungsdaten: solange der Workspace besteht und bis zu seiner Löschung",
            "Buchungsjournal, Abrechnungsangaben und zugehörige Belege: bis zum Ablauf der gesetzlichen Aufbewahrungsfristen (derzeit bis zu acht Jahre für Buchungsbelege, sechs Jahre für Handels- und Geschäftsbriefe); danach löschen wir sie",
          ],
        },
        "Löschung: Eine Löschung von Konto oder Workspace können Sie jederzeit per E-Mail an info@itegro-gmbh.de verlangen; sie erfolgt nach Prüfung Ihrer Berechtigung innerhalb angemessener Frist. Daten, die wir aus gesetzlichen Gründen aufbewahren müssen, insbesondere das unveränderliche Buchungsjournal, löschen wir dann nicht sofort, sondern schränken ihre Verarbeitung ein (Art. 18 DSGVO) und verwenden sie nur noch für die gesetzlichen Zwecke, bis die Frist abgelaufen ist. Die Kennung des GitHub-Kontos für den Schutz des Startguthabens bleibt ebenfalls gespeichert (Abschnitt 14). Kommentare, die wir an Pull Requests veröffentlicht haben, liegen bei GitHub in Ihrem Repository und werden von uns nicht gelöscht; Sie können sie dort selbst entfernen.",
      ],
    },
    {
      id: "de-empfaenger",
      heading: "18. Empfänger und Übermittlungen in Drittländer im Überblick",
      blocks: [
        "Empfänger personenbezogener Daten sind, je nachdem, welches Angebot Sie nutzen:",
        {
          list: [
            "Cloudflare, Inc., USA: Auslieferung der Website (Abschnitt 3)",
            "PostHog Inc., USA, Server in der EU: Reichweitenmessung der Website, im gemeinsamen Projekt der Itegro GmbH (Abschnitt 5)",
            "Vercel Inc., USA, Region Frankfurt am Main: Hosting der Anwendung und Ausführung der Reviews (Abschnitte 9 und 12)",
            "Neon, Inc., USA, Datenbank in der Region Frankfurt am Main: Datenbank der Anwendung (Abschnitt 9)",
            "Anthropic PBC und OpenRouter, Inc., beide USA, oder der vom Kunden gewählte KI-Anbieter: Verarbeitung der Anfragen bei Reviews (Abschnitt 12)",
            "GitHub, Inc., USA: Quelle der Repositories und Anmeldedienst (Abschnitt 11)",
            "Stripe (Stripe-Gruppe, auch in den USA): Merchant of Record und Zahlungsabwickler für Guthaben (Abschnitt 14)",
            "Resend, Inc., USA: Versand der E-Mails der Anwendung (Abschnitt 15)",
            "unser E-Mail-Anbieter für Nachrichten an info@itegro-gmbh.de (Abschnitt 6)",
          ],
        },
        "Eine Weitergabe an staatliche Stellen erfolgt nur, wenn wir dazu gesetzlich verpflichtet sind. Soweit Empfänger in den USA sitzen, stützen wir die Übermittlung auf den Angemessenheitsbeschluss zum EU-US Data Privacy Framework (Art. 45 DSGVO) oder auf die Standardvertragsklauseln der Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO), wie in den genannten Abschnitten beschrieben. Eine Kopie der Garantien erhalten Sie auf Anfrage.",
      ],
    },
    {
      id: "de-rechte",
      heading: "19. Ihre Rechte",
      blocks: [
        "Sie haben uns gegenüber hinsichtlich der Sie betreffenden personenbezogenen Daten folgende Rechte:",
        {
          list: [
            "Recht auf Auskunft (Art. 15 DSGVO)",
            "Recht auf Berichtigung (Art. 16 DSGVO)",
            "Recht auf Löschung (Art. 17 DSGVO)",
            "Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO)",
            "Recht auf Datenübertragbarkeit (Art. 20 DSGVO)",
            "Recht auf Widerspruch gegen die Verarbeitung (Art. 21 DSGVO)",
          ],
        },
        "Widerspruchsrecht: Soweit wir Daten auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO verarbeiten, können Sie dieser Verarbeitung aus Gründen, die sich aus Ihrer besonderen Situation ergeben, jederzeit widersprechen. Wir verarbeiten die Daten dann nicht mehr, es sei denn, wir können zwingende schutzwürdige Gründe für die Verarbeitung nachweisen, die Ihre Interessen, Rechte und Freiheiten überwiegen, oder die Verarbeitung dient der Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen.",
        "Widerruf einer Einwilligung: Eine erteilte Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3 DSGVO). Die Einwilligung in die Reichweitenmessung widerrufen Sie über den Link „Cookie settings“ im Fußbereich (Abschnitt 5).",
        "Daten in Repositories unserer Kunden: Betreffen Ihre Anfragen Inhalte, die wir als Auftragsverarbeiter eines Kunden verarbeiten (Abschnitt 8), leiten wir sie an den Kunden weiter oder verweisen Sie an ihn, soweit wir nicht selbst Verantwortlicher sind.",
        "Beschwerderecht: Sie haben das Recht, sich bei einer Datenschutzaufsichtsbehörde zu beschweren (Art. 77 DSGVO). Für uns zuständig ist das Bayerische Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18, 91522 Ansbach.",
        "Um Ihre Rechte auszuüben, genügt eine E-Mail an info@itegro-gmbh.de.",
      ],
    },
    {
      id: "de-pflicht",
      heading: "20. Bereitstellung der Daten und automatisierte Entscheidungen",
      blocks: [
        "Beim Besuch der Website sind Sie weder gesetzlich noch vertraglich verpflichtet, uns personenbezogene Daten bereitzustellen; ohne die Verarbeitung Ihrer IP-Adresse kann die Website jedoch technisch nicht ausgeliefert werden. Für ein Konto in der Anwendung sind die Kontodaten, für das Aufladen von Guthaben die Abrechnungsangaben erforderlich; ohne sie können wir den Vertrag nicht durchführen.",
        "Eine ausschließlich automatisierte Entscheidung mit rechtlicher Wirkung oder ähnlich erheblicher Beeinträchtigung einschließlich Profiling (Art. 22 DSGVO) findet nicht statt. Die Reviews sind KI-gestützt; über ihre Verwendung entscheiden die Nutzer. Dass neue Reviews bei leerem oder negativem Guthaben, erreichtem Monatslimit oder zur Missbrauchsabwehr nicht gestartet werden, ist eine vertraglich vorgesehene Folge, die nicht an persönliche Merkmale anknüpft.",
      ],
    },
    {
      id: "de-aenderungen",
      heading: "21. Änderungen",
      blocks: [
        "Wir passen diese Datenschutzerklärung an, wenn sich die Website, die Anwendung oder die Rechtslage ändert, zum Beispiel wenn wir einen weiteren Dienstleister einsetzen oder den Funktionsumfang erweitern. Es gilt die jeweils hier veröffentlichte Fassung.",
      ],
    },
  ],
};

export const PRIVACY_EN: LegalDocument = {
  lang: "en",
  title: "Privacy policy (English translation)",
  dateLabel: `Last updated: ${PRIVACY_DATE.en}`,
  note: "The German version above is the binding one.",
  sections: [
    {
      id: "en-controller",
      heading: "1. Controller",
      blocks: [
        "The controller responsible for processing personal data on the website code-review.com and in the application at app.code-review.com within the meaning of the General Data Protection Regulation (GDPR) is:",
        { list: CONTROLLER_EN },
        "Where we process content from our customers' repositories while carrying out reviews, we act as a processor for these customers (section 8).",
        "We have not appointed a data protection officer because we are not legally required to (Art. 37 GDPR, § 38 BDSG).",
      ],
    },
    {
      id: "en-overview",
      heading: "2. Overview and scope",
      blocks: [
        "This privacy policy covers two offerings: the website code-review.com (part A, sections 3 to 7) and the application at app.code-review.com, the hosted version of code-review.com (part B, sections 8 to 17). Sections 18 to 21 apply to both.",
        "The website consists of static files and informs about code-review.com. It has no forms and no user accounts. We only process personal data there where this is technically necessary to deliver the website (section 3), with your consent for analytics with PostHog (including the link to itegro-gmbh.de and the hand-over to the application, section 5) and without consent for pseudonymous cookieless counting (section 5) and when you write to us by email (section 6).",
        "In the application you sign in with your GitHub account or, where offered, with an email address and password, install our GitHub App on repositories of your choice and have pull requests reviewed by AI models. In doing so we process account data, GitHub data, content of the reviewed repositories and pull requests, usage data and billing data (sections 8 to 17). The application is aimed at businesses; if you use an account as an employee or staff member of a customer, this policy concerns you as a user.",
      ],
    },
    {
      id: "en-hosting",
      heading: "3. Hosting with Cloudflare and server log data",
      blocks: [
        "This website is delivered as static files through Cloudflare Workers, a service of Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA. Cloudflare runs a worldwide network of data centres (content delivery network); your request is usually answered by a data centre near you. Cloudflare processes the data on our behalf. The data processing agreement according to Art. 28 GDPR (Cloudflare Data Processing Addendum) is part of Cloudflare's terms of service.",
        "Whenever you open the website, your browser automatically sends data to Cloudflare. In particular, Cloudflare processes:",
        {
          list: [
            "the IP address of the requesting device",
            "date and time of the request",
            "the requested address (URL) and the HTTP method",
            "the HTTP status code",
            "the page you came from (referrer), if your browser sends it",
            "browser and operating system (user agent)",
            "other technical details of the connection and the request that Cloudflare evaluates to fend off attacks (such as overload attacks and malicious bots) and to keep delivery fast",
          ],
        },
        "This data is processed to deliver the website, to keep it secure and stable and to analyse errors. The legal basis is Art. 6(1)(f) GDPR; our legitimate interest is the secure, fast and reliable provision of the website. We do not combine this data with other data, do not evaluate it for advertising or analytics and do not pass it on to third parties.",
        "Transfer to the USA: Cloudflare is based in the USA, so data may be transferred to the USA. Cloudflare is certified under the EU-US Data Privacy Framework; for certified companies an adequacy decision of the European Commission applies (Art. 45 GDPR). Should this basis cease to apply, the contract with Cloudflare includes the European Commission's standard contractual clauses (Art. 46(2)(c) GDPR).",
        "Retention: according to Cloudflare, it keeps this data only as long as necessary for these purposes. We have not set up any storage or forwarding of request logs for us. In our Cloudflare account we see aggregated statistics, such as the number of requests, and details of individual requests only when Cloudflare has detected and blocked them as an attack.",
        "We do not use Cloudflare Web Analytics or any other analytics features of Cloudflare. Requests for analytics (section 5) also pass through Cloudflare and are handled there like any other request to this website.",
        "The connection to this website is encrypted with TLS (https).",
      ],
    },
    {
      id: "en-cookies",
      heading: "4. Cookies, consent and local storage",
      blocks: [
        "Without your consent this website sets no cookies for analytics. We then only store your choice in the consent dialog (consent manager \"Klaro\", a tool that runs from our own domain and sends no data to third parties): in a cookie on code-review.com (`code-review_klaro`, lifetime 180 days) we keep whether you accepted or declined analytics. The cookie contains no identifier and we do not evaluate it; your browser sends it with requests to this website like any cookie (section 3). It is strictly necessary under section 25(2) no. 2 TDDDG so that we can honour your choice. The legal basis is Art. 6(1)(c) in conjunction with Art. 7(1) GDPR and Art. 6(1)(f) GDPR (proof of consent). We ask again after the 180 days. We no longer use a choice from the earlier dialog of this website (the item `cr_consent` in local storage); you are asked once again, because your consent now reaches further (section 5).",
        "If you explicitly accept analytics, the cookies and storage entries from PostHog described in section 5 are added: a cookie on code-review.com (`ph_…_posthog`, lifetime up to twelve months) and entries in `localStorage` and `sessionStorage` (`ph_…`) with a random ID and session data. These technologies are not strictly necessary, so we only use them with your consent. If you decline or withdraw your consent, they are deleted.",
        "Fonts, images, scripts and all other files come only through our hosting with Cloudflare (section 3). Except for PostHog, and only with your consent (section 5), no content is loaded from other providers. We have not enabled any Cloudflare features that set cookies or insert scripts into the website. The light or dark appearance follows your system setting without storing anything.",
      ],
    },
    {
      id: "analytics",
      heading: "5. Analytics with PostHog",
      blocks: [
        "This website measures how it is used with PostHog. You have the choice, and \"Accept\" and \"Decline\" carry equal weight: the website works the same either way. As long as you have not made a choice, PostHog is not loaded, no connection to PostHog is made, no cookie is set by PostHog and nothing is stored on your device by PostHog. If you choose \"Accept\", we load PostHog and measure in more detail (\"With your consent\" below). If you choose \"Decline\" or your browser sends the Global Privacy Control or Do Not Track signal, we only count pseudonymously and without cookies (\"Pseudonymous counting\" below); with such a signal we do not show the dialog, but you can still accept explicitly through the \"Cookie settings\" link in the footer.",
        "Provider and recipients: PostHog Inc., 2261 Market Street #4008, San Francisco, CA 94114, USA. We use PostHog Cloud EU; the data is stored on servers in the European Union (Frankfurt). PostHog processes the data on our behalf under a data processing agreement under Art. 28 GDPR. Because PostHog Inc. is a US company, access from the USA cannot be ruled out. PostHog Inc. is certified under the EU-US Data Privacy Framework; for certified companies an adequacy decision of the European Commission applies (Art. 45 GDPR). In addition, the data processing agreement includes the EU standard contractual clauses (Art. 46(2)(c) GDPR). We use the PostHog project that Itegro GmbH runs for all of its websites together (code-review.com and itegro-gmbh.de). The data of these websites is therefore in the same project, where the websites are told apart by a label; Itegro GmbH is the controller in both cases.",
        "Route of the requests: your browser does not send the data to PostHog directly but to our own domain (addresses starting with `/ingest`). A script we run on Cloudflare Workers (section 3) receives it and forwards it to PostHog in the EU. The script stores nothing. It removes cookies and credentials (the \"Cookie\" and \"Authorization\" headers) from the request but passes on everything else in the request unchanged that your browser and Cloudflare send along, in particular the page visited (\"Referer\" header), the user agent, the language setting and your IP address. We pass your IP address on to PostHog in both modes, so that PostHog can determine an approximate location and count visitors correctly in pseudonymous counting. PostHog does not store the IP address with the event data: in our PostHog organisation (EU cloud) the storage of the client IP (\"IP data capture\") is switched off. How precisely the location derived from the IP address is stored (country, region, city) depends on the settings of our PostHog project.",
        "With your consent: we process the pages visited (address and title), the referrer, the time and the time spent on a page, browser, operating system, device type, screen size, language and time zone, the approximate location that PostHog derives from the IP address (country, region and city, depending on the settings of our PostHog project), individual clicks, scroll and mouse movements (autocapture and heatmaps), repeated rapid clicks (\"rage clicks\") and clicks without effect (\"dead clicks\"), error messages of the page (message and technical trace, without inputs), loading times of the page and of the requests the page makes (web vitals and network timing), short surveys about the website and recordings of individual sessions (session replay). Session replay records the page structure and the movements; all inputs are masked, so what you type is not visible. A randomly generated ID and a session ID are stored in the cookie above and in `localStorage` and `sessionStorage` (`ph_…`); if surveys are shown, PostHog also remembers there which ones you have already seen (`seenSurvey_…`, `inProgressSurvey_…`, `lastSeenSurveyDate`). We do not create person profiles and do not link the data to your name or email address.",
        "Link to itegro-gmbh.de (only with consent): if you click a link from this website to itegro-gmbh.de while in this state, we append the random visitor ID and the session ID from your PostHog cookie, plus the current time, to the address as parameters (`ph_did`, `ph_sid`, `ph_ts`), and only at the moment you open the link (click, ctrl or cmd click, middle click, Enter). The link on the page itself stays without parameters; if you copy or drag it, you pass no ID on. itegro-gmbh.de, also a website of Itegro GmbH in the same PostHog project, removes the parameters from the address at once. If you have consented there as well and the link is at most two minutes old, PostHog recognises you as the same visitor in the same session; otherwise (also for older links and invalid values) the IDs are discarded. If a link from itegro-gmbh.de to this website carries such parameters, this website treats them the same way: if you have consented here and the link is at most two minutes old, PostHog takes over the IDs, otherwise they are discarded; the parameters are removed from the address at once in every case. Without your consent on the respective website, no IDs are appended or taken over. Your consent applies per website, so you may be asked again on the target site.",
        "Hand-over to the application (only with consent): if you click a link to the application at app.code-review.com (sign up or sign in) while in this state, we likewise append the visitor ID, the session ID and the time as parameters (`ph_did`, `ph_sid`, `ph_ts`) to the address, again only at the moment you open the link, and we capture the click as an event (`cta_clicked`, with the kind of link and the place on the page). The application takes the valid IDs (not the time) into a short lived cookie (`__Host-cr-landing`, section 10) when the page for signing up or signing in is opened, and removes the parameters from the address. At sign up or at your first sign in, it stores the valid IDs together with your user account as long as none are stored for it yet, in order to attribute the sign up to the visit of this website (origin of sign ups); IDs that are already stored are not replaced. The IDs are deleted with the account (section 17). Without your consent, in pseudonymous counting and with a privacy signal, nothing is appended and the application receives no ID.",
        "Purpose and legal basis (with consent): the purpose is statistical analysis of site usage to improve the content, structure and usability of the website and to find errors, and to understand which visits to this website lead to a sign up. The legal basis is your consent under Art. 6(1)(a) GDPR and section 25(1) TDDDG, which also covers reading the ID for the hand-over to itegro-gmbh.de and the application. You can withdraw your consent at any time.",
        "Pseudonymous counting (without consent): if you choose \"Decline\" or send a privacy signal, we only count how often pages are opened and left. PostHog then runs in its cookieless mode: no cookie is set and nothing is stored in `localStorage` or `sessionStorage`. For this the script reads from your browser only what it sends to PostHog with the page view: the address and title of the page, the referrer, browser and version, operating system, device type, screen and window size, language setting and time zone, and when you leave the page the time spent and the scroll depth; the label of the website is added. From the IP address, the browser identification (user agent) and a salt that changes daily, PostHog builds an identifier on its servers that does not allow an assignment across several days and that we do not link to you as a person. Because the IP address goes into this identifier, the data is pseudonymous, not anonymous. Session recordings, heatmaps, surveys, error capture and autocapture are switched off in this mode, and so is appending IDs to links. The legal basis is Art. 6(1)(f) GDPR; our legitimate interest is a privacy friendly measurement. Because nothing is stored on your device and only the technical details named are read, which do not serve to recognise you on your device, we believe the consent requirement of section 25(1) TDDDG does not apply.",
        "Retention: how long PostHog keeps session recordings is set in the settings of our PostHog project (currently 30 days); they are deleted afterwards. We keep event data (page views, clicks, errors and the like) only as long as needed for the analysis and delete it afterwards. The cookie `ph_…_posthog` and the entries in your browser stay until you delete them or withdraw your consent, twelve months at most; the cookie of the consent dialog is valid for 180 days. After that we ask again.",
        "Withdrawal: you can withdraw your consent at any time with effect for the future, using the \"Cookie settings\" link in the footer of every page. The page then deletes the PostHog cookies and the PostHog entries in your browser, reloads and switches to pseudonymous counting without cookies. The processing carried out before the withdrawal stays lawful. We delete data already collected on request where we can link it to you; for that we need the ID from your browser. IDs already handed over to the application are deleted on request together with your account or, if you wish, beforehand (section 17).",
      ],
    },
    {
      id: "en-contact",
      heading: "6. Contact by email",
      blocks: [
        "When you write to us by email, we process your email address, your name if you give it, and the content of your message in order to answer your request. The legal basis is Art. 6(1)(b) GDPR if your request relates to a contract or to steps prior to entering into one, and Art. 6(1)(f) GDPR otherwise; our legitimate interest is answering requests.",
        "Your emails are stored with our email provider, which processes them on our behalf (Art. 28 GDPR). We delete the data once your request has been dealt with, unless statutory retention obligations apply; we keep business letters for six years under § 257 HGB and § 147 AO.",
      ],
    },
    {
      id: "en-links",
      heading: "7. Links to other websites",
      blocks: [
        "This website contains links to GitHub (GitHub, Inc., USA), to itegro-gmbh.de (website of Itegro GmbH) and to the application at app.code-review.com. They are plain links: as long as you do not click one, no data is transferred to these providers. If you click a link, you open the other website, and its privacy policy applies. If you have consented to analytics, we append IDs to the links to itegro-gmbh.de and to the application (section 5).",
      ],
    },
    {
      id: "en-roles",
      heading: "8. Our role in the application",
      blocks: [
        "We are the controller for the data we process for your account, sign in, billing, security and the operation of the application (sections 10 and 14 to 17).",
        "We are a processor where we process content of our customers' repositories and pull requests while carrying out reviews (sections 11 and 12). The controller is then the customer, that is, the company that runs the workspace. We conclude a data processing agreement under Art. 28 GDPR with the customer; it is part of our terms of service (code-review.com/terms/). Third parties whose data appears in a repository (for example authors of commits) should first contact the company whose repository is concerned; we support it in answering.",
      ],
    },
    {
      id: "en-hosting-app",
      heading: "9. Hosting and infrastructure of the application",
      blocks: [
        "Application and review infrastructure: the application, the Dispatcher (the service that starts a compute unit for each review) and the virtual machines in which reviews run (Vercel Sandbox) are operated by Vercel Inc., USA, in the region Frankfurt am Main (fra1) in the European Union. The application does not run through Cloudflare; Cloudflare delivers only the website (section 3). Vercel processes the data on our behalf under a data processing agreement under Art. 28 GDPR. When you open the application, Vercel processes technically necessary connection data such as IP address, time, requested address, status code and user agent to deliver and protect the application. The legal basis is Art. 6(1)(b) GDPR (providing the application to customers and their users) and Art. 6(1)(f) GDPR (secure and stable operation).",
        "Database: the data of the application (accounts, workspaces, settings, encrypted keys, information on reviews, billing journal) is stored in a managed PostgreSQL database at Neon, Inc., USA. The database runs in the region Europe Central (AWS eu-central-1, Frankfurt am Main), so the data is stored in the European Union. The connection is encrypted with TLS. Neon processes the data on our behalf under a data processing agreement under Art. 28 GDPR.",
        "Transfer to the USA: Vercel and Neon are based in the USA or have their parent company there; access from the USA cannot be ruled out despite storage in the EU. We base the transfer on the adequacy decision of the European Commission on the EU-US Data Privacy Framework (Art. 45 GDPR), where the recipient is certified under it, and otherwise on the standard contractual clauses of the European Commission (Art. 46(2)(c) GDPR).",
      ],
    },
    {
      id: "en-account",
      heading: "10. Account, sign in and sessions",
      blocks: [
        "Sign in with GitHub: after your consent, GitHub sends us your GitHub ID, your login name, your name, the address of your profile picture and your primary email address verified at GitHub. Signing in does not give us access to your repositories; access only arises when a customer installs our GitHub App on repositories (section 11). We store the access token issued by GitHub in encrypted form.",
        "Sign in with email address and password (where offered): we store your email address, your name and a hash of your password, never the password itself. To confirm the address and to reset the password we create links, of which we store only a hash.",
        "Workspaces and roles: a workspace belongs to a customer. We store who is a member, with which role (Owner, Admin or Member) and which invitations are open (email address of the invited person, inviting person). Members of a workspace see the names, email addresses and roles of the other members.",
        "Sessions and security: after you sign in, we store a session with an ID, an expiry time (30 days), the IP address and the user agent. In addition we count sign in attempts and other requests per address, link or account (as a hash) to fend off abuse and attacks.",
        "Cookies and local storage in the application: the application sets a session cookie that keeps you signed in (over https only, up to 30 days) and short lived cookies for the course of the sign in with GitHub. It also stores your sidebar setting in a cookie (`sidebar_state`, seven days) and, if you pin light or dark mode, that choice in your browser's local storage (`code-reviewer-theme`, no identifier). Under section 25(2) no. 2 TDDDG this access is necessary for us to provide the application you asked for; no consent is needed for it. The cookie `__Host-cr-landing` is an exception: it is only set after a link from the website with your consent (next paragraph). We use no analytics, advertising or tracking services in the application.",
        "Origin of the sign up (only with consent): if you consented to analytics on the website code-review.com and come from there to sign up or sign in, the website passes on the PostHog visitor ID and session ID (parameters `ph_did` and `ph_sid`, section 5). When the page is opened, the application puts the valid IDs into a cookie (`__Host-cr-landing`, only on app.code-review.com, HttpOnly, Secure, valid for one hour; if only one of the two IDs is valid, only that one is put there) and removes the parameters from the address. The cookie only makes the IDs survive the sign in, the redirect to GitHub and the way back; no script can read it, and it is deleted at the first sign up or sign in that sees it. On that first request, however, the IDs are still part of the address and can therefore appear in the request logs of the application's hosting provider (section 9) for their usual retention period. At sign up or at your first sign in, we store the valid IDs with your account as long as none are stored for it yet (IDs already stored are not replaced), in order to attribute the sign up to the visit of the website. The application loads no PostHog for this and does not send the IDs to PostHog. They are not needed for you to use the application, and without your consent on the website they are not passed on. The legal basis is your consent on the website (Art. 6(1)(a) GDPR, section 25(1) TDDDG).",
        "Legal basis: Art. 6(1)(b) GDPR where you are a party to the contract yourself or the contract with your employer provides for your use; otherwise Art. 6(1)(f) GDPR (providing the application to the staff of our customers, security and abuse prevention).",
      ],
    },
    {
      id: "en-github",
      heading: "11. The GitHub App and your repositories",
      blocks: [
        "A customer installs our GitHub App on the repositories that are to be reviewed. The App receives these permissions from GitHub: Pull requests (read and write), Issues (read and write, for comments and reactions on pull requests), Contents (read only), Metadata (read only) and Checks (read and write, for the status display on the pull request), plus as an account permission reading email addresses (for sign in) and as an organization permission reading memberships (to check your role when an organization is linked). We do not write code to your repositories.",
        "GitHub reports events about pull requests and comments to us by webhook. From them we process the installation, the account or organization, the repositories (name and ID), the number and state of the pull request, the current commit and the login of the person who triggers a review (for example with the comment `/review`), including whether they have write access. For every review we create a short lived access token from GitHub that is valid only for the one repository of that review. We publish the results of a review as comments, reactions and a check run on the pull request, that is, in your repository at GitHub.",
        "GitHub (GitHub, Inc., USA) is a controller in its own right; its privacy statement applies to processing by GitHub. The legal basis of our processing is Art. 6(1)(b) GDPR; where we act as a processor, section 8.",
      ],
    },
    {
      id: "en-reviews",
      heading: "12. Carrying out reviews and passing data to AI providers",
      blocks: [
        "Process: when a pull request or a comment triggers a review, we create a job. For it, the Dispatcher starts a fresh, non persistent virtual machine in the region Frankfurt am Main (Vercel Sandbox), created from an image that contains no customer data. In it, a program (the Worker) uses the short lived GitHub token to read the changes of the pull request (Diff Review) or, for a Dynamic Review, the repository, read only, including rule files such as `AGENTS.md`, and queries an AI model. The result is published on the pull request. After the review the virtual machine is ended; it holds no permanent copy.",
        "Passing data to the AI provider: for the request to the model we transmit excerpts of your code and pull requests, in particular the changed lines, file contents, file names, the title, description and comments of the pull request, information on commits (for example author names) and instructions you stored for the project. This content may contain personal data.",
        "Which provider: if the workspace uses the managed models, we use the providers we have engaged; at present these are Anthropic PBC, USA, and, where set up, OpenRouter, Inc., USA. We have agreed commercial access (API) with them; where provided, their terms on data processing apply. If the workspace uses its own key, the request goes to the provider the customer chose from the model catalog and has its own contract with; we then transmit the content on behalf of and on the instructions of the customer. What data a model provider stores, for how long, or uses for its own purposes follows the terms of that provider. We ourselves do not use the content of your repositories or the answers of the models to train models and do not pass them on to third parties for that purpose.",
        "What stays stored with us: for each review we store metadata (repository, number of the pull request, commit, trigger, status, times, error code), the link to the comment, the number of open findings by severity, a technical log excerpt of at most 8,192 characters in which credentials are made unreadable and which in individual cases may contain file paths or short text excerpts, and usage data (token counts, costs, duration, and for Dynamic Reviews a list of technical calls with numbers and names, without content). We do not store source code permanently; you find the text of the reviews on the pull request at GitHub.",
        "Legal basis: we process the content as a processor on behalf of the customer (section 8). We process the metadata and usage data as the controller on the basis of Art. 6(1)(b) GDPR (providing and billing the service) and Art. 6(1)(f) GDPR (operation, error analysis, security).",
        "Transfer to the USA: the AI providers named are based in the USA. We base the transfer on the standard contractual clauses of the European Commission (Art. 46(2)(c) GDPR), which are part of the terms of the respective provider, or, where the provider is certified, on the adequacy decision on the EU-US Data Privacy Framework (Art. 45 GDPR). With its own key, the customer regulates the transfer in its contract with the provider.",
      ],
    },
    {
      id: "en-keys",
      heading: "13. Own keys and the model catalog",
      blocks: [
        "A customer can store its own API keys of AI providers for its workspace. We store them encrypted, do not show them again after saving, and use them only for reviews of that workspace. For a review we pass the key on to the Worker; an encrypted copy is kept for at most seven days after the end of the job so that the key can also be made unreadable in results that are reported late. We delete stored keys when you remove them or the workspace is deleted.",
        "The directory of available providers and models (names, prices, context sizes) is loaded daily from the public catalog models.dev. No data of users or customers is transmitted in the process; models.dev only sees the connection data of our server.",
      ],
    },
    {
      id: "en-payments",
      heading: "14. Billing, credit and payments",
      blocks: [
        "The application is billed with prepaid credit per workspace (details in the terms of service). Owners and Admins of a workspace can top up credit. Payment runs through Stripe Managed Payments: the merchant of record and payment processor is Stripe (Sold through Link, LLC and other companies of the Stripe group, shown in the checkout as “Sold through Link”). Stripe collects the payment data (for example card or bank details), issues receipts and invoices and takes care of VAT, fraud prevention and disputes. Stripe is a controller in its own right for this; the privacy terms of Stripe apply (stripe.com/privacy). We receive no card or bank details, only the status of the payment, the amount and reference IDs.",
        "Billing details: before the first top up we collect, per workspace, your company name, your address and optionally your VAT ID, as well as your confirmation that you buy as a business (with time, acting person and version of the terms). Only Owners and Admins of the workspace see these details. We transmit them to Stripe so that the receipt and invoice can be issued to your company, and we do not write them to logs.",
        "Booking journal: for each workspace we keep a journal of all movements: top ups, start credit, charges per review (split into an AI part and an infrastructure part), refunds, chargebacks and corrections, each with the date and reference IDs from Stripe. The journal cannot be changed and is visible to all members of the workspace. Stripe deletes its records on request of buyers; the journal contains only our amounts and IDs.",
        "Abuse protection: we grant the start credit once per GitHub account. For this we store the ID of the GitHub account of the installation, also beyond the deletion of a workspace. We also limit the number of reviews per period and implement a monthly spending limit at the customer's request. The legal basis is Art. 6(1)(f) GDPR (protection against abuse of the start credit and the infrastructure).",
        "Legal bases: Art. 6(1)(b) GDPR (top up, billing), Art. 6(1)(c) GDPR in conjunction with § 257 HGB and § 147 AO (commercial and tax law retention) and Art. 6(1)(f) GDPR (abuse protection, enforcement of claims).",
        "Transfer to the USA: Stripe processes payment data through companies of the Stripe group, including in the USA, on the basis of its own safeguards (adequacy decision on the EU-US Data Privacy Framework where certified, otherwise standard contractual clauses).",
      ],
    },
    {
      id: "en-mails",
      heading: "15. Emails of the application",
      blocks: [
        "The application sends emails to confirm email addresses, reset passwords, invite people to a workspace and notify Owners and Admins when the credit is low or used up. For this we process the email address, the name and the content of the message (for example a link or the name of the workspace). The emails are sent through the email service Resend of Resend, Inc., USA, which processes the data on our behalf (Art. 28 GDPR); the connection is encrypted. The legal basis is Art. 6(1)(b) GDPR and, for security emails, Art. 6(1)(f) GDPR. Transfer to the USA: we base the transfer to Resend on the adequacy decision of the European Commission on the EU-US Data Privacy Framework (Art. 45 GDPR), where Resend is certified under it, and otherwise on the standard contractual clauses of the European Commission (Art. 46(2)(c) GDPR).",
      ],
    },
    {
      id: "en-logs",
      heading: "16. Logs and troubleshooting",
      blocks: [
        "For operation we keep operational logs (at Vercel). They contain IDs and error codes, but no content of repositories, no content of requests or responses, no credentials and no billing details. Vercel keeps these logs only for a short time under its own rules. The purpose is stable and secure operation, error analysis and the investigation of abuse; the legal basis is Art. 6(1)(f) GDPR. We do not use third party error monitoring or usage analytics services in the application.",
      ],
    },
    {
      id: "en-retention",
      heading: "17. Retention and deletion",
      blocks: [
        "We keep personal data in the application only as long as needed for the respective purpose:",
        {
          list: [
            "account, memberships and settings: until the account or the workspace is deleted",
            "unconfirmed sign ups with email address and password: seven days after sign up",
            "links for confirmation and reset: valid for 24 hours and 30 minutes respectively, kept for at most seven days after that",
            "sessions: valid for 30 days; the records stay stored until the account is deleted",
            "IDs for the origin of the sign up (PostHog visitor and session ID, only with consent on the website): until the account is deleted",
            "counters against abuse: at most 24 hours",
            "encrypted copy of a key for a job: up to seven days after the end of the job; stored keys: until you remove them",
            "technical details of handing a job to the Dispatcher: seven days after the end of the job",
            "information on reviews, log excerpts and usage data: as long as the workspace exists and until it is deleted",
            "booking journal, billing details and related receipts: until the statutory retention periods have expired (currently up to eight years for accounting records, six years for commercial and business letters); after that we delete them",
          ],
        },
        "Deletion: you can request the deletion of an account or workspace at any time by email to info@itegro-gmbh.de; after checking your authority, it is carried out within a reasonable period. Data we are required to keep for legal reasons, in particular the immutable booking journal, we then do not delete immediately but restrict its processing (Art. 18 GDPR) and use it only for the legal purposes until the period has expired. The ID of the GitHub account for protecting the start credit also stays stored (section 14). Comments we published on pull requests are in your repository at GitHub and are not deleted by us; you can remove them there yourself.",
      ],
    },
    {
      id: "en-recipients",
      heading: "18. Recipients and transfers to third countries at a glance",
      blocks: [
        "Recipients of personal data are, depending on which offering you use:",
        {
          list: [
            "Cloudflare, Inc., USA: delivery of the website (section 3)",
            "PostHog Inc., USA, servers in the EU: analytics of the website, in the shared project of Itegro GmbH (section 5)",
            "Vercel Inc., USA, region Frankfurt am Main: hosting of the application and running of reviews (sections 9 and 12)",
            "Neon, Inc., USA, database in the region Frankfurt am Main: database of the application (section 9)",
            "Anthropic PBC and OpenRouter, Inc., both USA, or the AI provider chosen by the customer: processing of the requests during reviews (section 12)",
            "GitHub, Inc., USA: source of the repositories and sign in service (section 11)",
            "Stripe (Stripe group, also in the USA): merchant of record and payment processor for credit (section 14)",
            "Resend, Inc., USA: sending the emails of the application (section 15)",
            "our email provider for messages to info@itegro-gmbh.de (section 6)",
          ],
        },
        "Data is passed on to public authorities only where we are legally obliged to. Where recipients are based in the USA, we base the transfer on the adequacy decision on the EU-US Data Privacy Framework (Art. 45 GDPR) or on the standard contractual clauses of the European Commission (Art. 46(2)(c) GDPR), as described in the sections named. You can obtain a copy of the safeguards on request.",
      ],
    },
    {
      id: "en-rights",
      heading: "19. Your rights",
      blocks: [
        "With regard to the personal data concerning you, you have the following rights towards us:",
        {
          list: [
            "right of access (Art. 15 GDPR)",
            "right to rectification (Art. 16 GDPR)",
            "right to erasure (Art. 17 GDPR)",
            "right to restriction of processing (Art. 18 GDPR)",
            "right to data portability (Art. 20 GDPR)",
            "right to object to processing (Art. 21 GDPR)",
          ],
        },
        "Right to object: where we process data on the basis of Art. 6(1)(f) GDPR, you may object to this processing at any time on grounds relating to your particular situation. We will then no longer process the data unless we can demonstrate compelling legitimate grounds for the processing which override your interests, rights and freedoms, or the processing serves the establishment, exercise or defence of legal claims.",
        "Withdrawing consent: you can withdraw any consent you have given at any time with effect for the future (Art. 7(3) GDPR). You withdraw your consent to analytics through the “Cookie settings” link in the footer (section 5).",
        "Data in our customers' repositories: if your requests concern content we process as a processor for a customer (section 8), we forward them to the customer or refer you to it, unless we are the controller ourselves.",
        "Right to lodge a complaint: you have the right to lodge a complaint with a data protection supervisory authority (Art. 77 GDPR). The authority responsible for us is the Bavarian State Office for Data Protection Supervision (Bayerisches Landesamt für Datenschutzaufsicht, BayLDA), Promenade 18, 91522 Ansbach, Germany.",
        "To exercise your rights, an email to info@itegro-gmbh.de is enough.",
      ],
    },
    {
      id: "en-obligation",
      heading: "20. Providing data and automated decisions",
      blocks: [
        "When you visit the website, you are not obliged by law or contract to provide us with personal data; without processing your IP address, however, the website cannot be delivered. For an account in the application the account data is required, and to top up credit the billing details are required; without them we cannot perform the contract.",
        "There is no solely automated decision with legal effect or similarly significant effect, including profiling (Art. 22 GDPR). The reviews are AI assisted; the users decide how to use them. That new reviews are not started when the balance is empty or negative, when the monthly limit is reached or to prevent abuse is a consequence provided for by contract that does not depend on personal characteristics.",
      ],
    },
    {
      id: "en-changes",
      heading: "21. Changes",
      blocks: [
        "We update this privacy policy when the website, the application or the legal situation changes, for example when we use a further service provider or extend the functionality. The version published here applies.",
      ],
    },
  ],
};
