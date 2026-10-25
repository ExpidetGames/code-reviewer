// SPDX-License-Identifier: LicenseRef-Proprietary

// Terms of service (AGB) of the hosted version of code-review.com (app.code-review.com): business customers
// only, prepaid credit in US dollars, payment through Stripe Managed Payments (Stripe is the merchant of
// record, Sold through Link, LLC), code of the customer is sent to the chosen AI provider, data processing agreement (Art. 28 GDPR)
// included. German (binding) and English translation.
// Legal text drafted without a lawyer (October 2026). Have it reviewed by one before relying on it.
// Facts come from the code and documentation of Itegro-GmbH/code-reviewer (docs/billing.md,
// docs/billing-terms-checklist.md, ADR 0006) and from the maintainer's decisions on issue #489. The points
// the owner has to confirm are listed in the pull request ("Bitte prüfen"). The page shows no TODO markers.
// Change TERMS_VERSION when the terms change: the application stores the version a customer confirmed at the
// first top up (BILLING_TERMS_VERSION in the app repository).
// The Markdown copies in legal/ are generated from this file (scripts/export-legal-markdown.mjs).
import type { LegalDocument } from "./legal-types";

export const TERMS_VERSION = "2026-10-24";
export const TERMS_DATE = { de: "24. Oktober 2026", en: "24 October 2026" } as const;

export const TERMS_DE: LegalDocument = {
  lang: "de",
  title: "Allgemeine Geschäftsbedingungen (AGB)",
  dateLabel: `Stand: ${TERMS_DATE.de}`,
  note: `Version ${TERMS_VERSION}`,
  sections: [
    {
      id: "de-agb-1",
      heading: "§ 1 Geltungsbereich, Anbieter, Unternehmer",
      blocks: [
        "(1) Anbieter des Dienstes code-review.com ist die Itegro GmbH, Buchberger Straße 10c, 82538 Geretsried, Deutschland (wir). Diese Allgemeinen Geschäftsbedingungen gelten für alle Verträge zwischen uns und unseren Kunden über die Nutzung der gehosteten Anwendung unter app.code-review.com und der zugehörigen Dienste (zusammen der Dienst), einschließlich der Nutzung ohne Abrechnung, des Startguthabens und der Nutzung mit einem eigenen KI-Schlüssel.",
        "(2) Der Dienst richtet sich ausschließlich an Unternehmer im Sinne des § 14 BGB sowie an juristische Personen des öffentlichen Rechts und öffentlich-rechtliche Sondervermögen. Verbrauchern (§ 13 BGB) bieten wir den Dienst nicht an. Der Kunde bestätigt vor der ersten Aufladung von Guthaben ausdrücklich, dass er als Unternehmer handelt, und sichert zu, den Dienst nur für gewerbliche oder selbständige berufliche Zwecke zu nutzen. Wer die Unternehmereigenschaft wahrheitswidrig bestätigt, trägt die daraus entstehenden Nachteile; wir können den Vertrag in diesem Fall außerordentlich kündigen (§ 11 Abs. 2).",
        "(3) Entgegenstehende oder abweichende Bedingungen des Kunden gelten nicht, auch wenn wir ihnen nicht ausdrücklich widersprechen. Abweichende Vereinbarungen bedürfen unserer Bestätigung in Textform.",
        "(4) Vertragssprache ist Deutsch. Die englische Fassung dient nur der Information; bei Abweichungen gilt die deutsche Fassung.",
      ],
    },
    {
      id: "de-agb-2",
      heading: "§ 2 Leistungen",
      blocks: [
        "(1) Der Dienst prüft Pull Requests auf GitHub mit Hilfe von KI-Modellen (Reviews) und veröffentlicht das Ergebnis als Kommentar, Review und Check Run am Pull Request. Es gibt zwei Arten von Reviews: den Diff Review, der die Änderungen eines Pull Requests prüft, und den Dynamic Review, bei dem ein KI-Agent das Repository lesend untersucht. Außerdem stellen wir eine Web-Anwendung bereit, in der der Kunde Workspaces, Projekte, Einstellungen, Schlüssel, Guthaben und Reviews verwaltet.",
        "(2) Der Leistungsumfang ergibt sich aus der Beschreibung des Dienstes auf code-review.com und in der Anwendung bei Vertragsschluss. Wir führen die Reviews mit der Sorgfalt eines fachkundigen Anbieters mit KI-Modellen Dritter durch; ein bestimmtes Prüfergebnis schulden wir nicht (§ 5).",
        "(3) Wir dürfen den Dienst weiterentwickeln und ändern, insbesondere Funktionen, Oberfläche, Review-Arten, eingesetzte Modelle und Anbieter sowie die technische Infrastruktur, sofern der Vertragszweck dadurch nicht wesentlich beeinträchtigt wird und die Änderung für den Kunden zumutbar ist. Bei Nutzung unserer verwalteten Modelle hat der Kunde keinen Anspruch auf ein bestimmtes Modell oder einen bestimmten Modellanbieter.",
        "(4) Funktionen, die als Vorabversion, Beta oder in Entwicklung gekennzeichnet sind, stellen wir ohne Zusage von Verfügbarkeit oder Stabilität bereit; wir können sie jederzeit ändern oder einstellen.",
        "(5) Der Kunde nutzt den Dienst je Workspace in einer von zwei Betriebsarten: mit unseren verwalteten Modellen (Preis aus KI-Anteil und Infrastrukturanteil, § 9) oder mit einem eigenen Schlüssel bei einem KI-Anbieter seiner Wahl (nur Infrastrukturanteil, § 10). Er wählt die Betriebsart in der Anwendung.",
      ],
    },
    {
      id: "de-agb-3",
      heading: "§ 3 Konto, Workspace und Vertragsschluss",
      blocks: [
        "(1) Der Kunde legt in der Anwendung ein Konto an und erstellt einen Workspace oder tritt einem bei. Die Anmeldung erfolgt über GitHub oder, soweit angeboten, mit E-Mail-Adresse und Passwort. Vertragspartner ist das Unternehmen, für das der Workspace angelegt wird. Wer einen Workspace anlegt oder Guthaben auflädt, versichert, dieses Unternehmen vertreten zu dürfen.",
        "(2) Der Vertrag kommt zustande, wenn wir die Registrierung annehmen, spätestens mit der Freischaltung des Kontos oder Workspace. Ein Anspruch auf Vertragsschluss besteht nicht; wir können Registrierungen ablehnen.",
        "(3) Der Kunde macht bei der Registrierung und bei den Abrechnungsangaben wahrheitsgemäße Angaben und hält sie aktuell, insbesondere Firmenname, Anschrift, Umsatzsteuer-Identifikationsnummer und E-Mail-Adresse. Nachteile aus falschen oder veralteten Angaben, etwa bei Belegen und Rechnungen, gehen zu Lasten des Kunden.",
        "(4) Der Kunde ist für seine Zugangsdaten und für alles verantwortlich, was in seinem Workspace durch seine Mitglieder geschieht. Er hält Zugangsdaten geheim, vergibt die Rollen (Owner, Admin, Member) mit Bedacht, entfernt ausgeschiedene Mitglieder und informiert uns unverzüglich über Missbrauch oder den Verdacht darauf. Owner und Admins dürfen den Kunden uns gegenüber vertreten, Guthaben aufladen und Einstellungen ändern.",
      ],
    },
    {
      id: "de-agb-4",
      heading: "§ 4 Pflichten des Kunden",
      blocks: [
        "(1) Der Kunde stellt sicher, dass er berechtigt ist, den Dienst auf die von ihm ausgewählten Repositories anzuwenden und deren Inhalte durch uns und unsere Dienstleister verarbeiten sowie an den gewählten KI-Anbieter übermitteln zu lassen. Er beachtet dabei Rechte Dritter, Lizenzbedingungen, Geheimhaltungspflichten gegenüber seinen Auftraggebern und datenschutzrechtliche Vorgaben. Er installiert die GitHub-App nur auf Repositories, für die er dazu befugt ist.",
        "(2) Der Kunde ist dafür verantwortlich, Inhalte, die nicht an einen KI-Anbieter übermittelt werden dürfen oder sollen (etwa Zugangsdaten, Schlüssel oder besonders schutzbedürftige personenbezogene Daten), nicht in Repositories oder Pull Requests aufzunehmen, die der Dienst prüft, oder diese Repositories nicht für den Dienst freizugeben.",
        "(3) Der Kunde unterlässt insbesondere:",
        {
          list: [
            "die Nutzung des Dienstes für rechtswidrige Inhalte oder Handlungen oder in einer Weise, die Rechte Dritter verletzt",
            "Angriffe auf den Dienst, seine Infrastruktur oder andere Kunden, insbesondere Versuche, die Isolation der Review-Umgebung zu überwinden, Zugangsdaten auszulesen oder die Modelle zu Zwecken zu steuern, die mit dem Review des eigenen Repositories nichts zu tun haben",
            "das Umgehen von Limits, Missbrauchsschutz oder Abrechnung, insbesondere das Anlegen mehrerer Konten oder Workspaces, um das Startguthaben mehrfach zu erhalten",
            "die Weitergabe von Zugangsdaten an Unbefugte",
            "übermäßige automatisierte Anfragen, die den Betrieb für andere Kunden beeinträchtigen",
          ],
        },
        "(4) Verstößt der Kunde gegen diese Pflichten, können wir nach § 11 Abs. 3 sperren. Der Kunde stellt uns von Ansprüchen Dritter frei, die auf einem schuldhaften Verstoß des Kunden gegen Absatz 1 oder 3 beruhen, und ersetzt uns die angemessenen Kosten der Rechtsverteidigung.",
      ],
    },
    {
      id: "de-agb-5",
      heading: "§ 5 KI-Ergebnisse",
      blocks: [
        "(1) Die Reviews werden von KI-Modellen erzeugt. Sie können fehlerhaft, unvollständig oder missverständlich sein, Fehler übersehen oder Probleme melden, die keine sind. Wir sagen nicht zu, dass ein Review bestimmte oder alle Fehler, Sicherheitslücken, Lizenz- oder Rechtsverstöße findet, dass seine Hinweise richtig sind oder dass ein Pull Request nach dem Review frei von Fehlern ist.",
        "(2) Ein Review ersetzt weder die Prüfung durch qualifizierte Personen noch Tests, Sicherheitsprüfungen oder Rechts- und Steuerberatung. Der Kunde entscheidet in eigener Verantwortung, ob und wie er Hinweise umsetzt und ob er Änderungen zusammenführt. Das gilt auch für Bewertungen, die der Dienst selbst setzt, etwa eine Freigabe oder das Ergebnis eines Check Runs.",
        "(3) Die vertragsgemäße Beschaffenheit des Dienstes besteht darin, dass die Reviews nach dem Stand der Technik durchgeführt werden (§ 2 Abs. 2), nicht in der inhaltlichen Richtigkeit oder Vollständigkeit der Ergebnisse.",
        "(4) Wir beanspruchen keine Rechte an den Ergebnissen eines Reviews; der Kunde darf sie frei verwenden. Wir können nicht ausschließen, dass Ergebnisse Inhalten Dritter ähneln; der Kunde prüft sie vor einer Übernahme.",
      ],
    },
    {
      id: "de-agb-6",
      heading: "§ 6 Vertraulichkeit und Umgang mit Quellcode",
      blocks: [
        "(1) Der Quellcode, die Pull Requests und alle weiteren Inhalte, die der Kunde über den Dienst verarbeiten lässt (Kundeninhalte), bleiben beim Kunden beziehungsweise seinen Rechteinhabern. Der Kunde räumt uns das einfache, nicht übertragbare Recht ein, die Kundeninhalte zu verarbeiten, an die für den Review eingesetzten Dienstleister und KI-Anbieter zu übermitteln und die Ergebnisse am Pull Request zu veröffentlichen, soweit das zur Erbringung des Dienstes erforderlich ist.",
        "(2) Wir behandeln Kundeninhalte vertraulich. Wir greifen auf Repositories nur lesend und nur für die Durchführung von Reviews zu, schreiben keinen Code in Repositories und verwenden für jeden Review ein kurzlebiges, auf ein einzelnes Repository beschränktes Zugriffstoken. Reviews laufen in frischen, nicht dauerhaften virtuellen Maschinen in der Region Frankfurt am Main, die nach dem Review beendet werden. Quellcode speichern wir nicht dauerhaft. Zu jedem Review speichern wir Metadaten, Nutzungsdaten und einen begrenzten technischen Protokollauszug (Datenschutzerklärung, Abschnitt 12).",
        "(3) Unsere Beschäftigten und Dienstleister erhalten Zugriff auf Kundeninhalte nur, soweit das für die Erbringung des Dienstes, die Fehlerbehebung oder die Abwehr von Missbrauch und Sicherheitsvorfällen erforderlich ist, und sind zur Vertraulichkeit verpflichtet.",
        "(4) Weitergabe an KI-Anbieter: Der Kunde weiß und akzeptiert, dass für jeden Review Auszüge der Kundeninhalte (insbesondere geänderte Zeilen, Dateiinhalte, Dateinamen, Beschreibungen und Kommentare des Pull Requests, Angaben zu Commits und Projektanweisungen) an den gewählten KI-Anbieter übermittelt werden. Bei den verwalteten Modellen sind das die von uns eingesetzten Anbieter, derzeit Anthropic PBC und, soweit eingerichtet, OpenRouter, Inc., beide USA. Bei einem eigenen Schlüssel ist es der Anbieter, den der Kunde wählt; das Vertragsverhältnis besteht dann zwischen dem Kunden und diesem Anbieter, dessen Bedingungen auch zu Speicherung, Verwendung und Training gelten, und wir übermitteln die Inhalte auf Weisung des Kunden. Der Kunde ist dafür verantwortlich, einen Anbieter zu wählen, dessen Bedingungen für seine Inhalte geeignet sind.",
        "(5) Kein Training: Wir verwenden Kundeninhalte und die Antworten der KI-Modelle nicht, um Modelle zu trainieren oder zu verbessern, und geben sie dafür nicht an Dritte weiter. Wir dürfen technische Nutzungsdaten ohne Kundeninhalte, etwa Tokenzahlen, Laufzeiten und Fehlercodes, für Abrechnung, Betrieb, Sicherheit und Weiterentwicklung des Dienstes auswerten.",
        "(6) Die Vertraulichkeit gilt nicht für Informationen, die allgemein bekannt sind oder ohne unser Zutun werden, und nicht für Offenlegungen, zu denen wir gesetzlich oder durch Entscheidung einer Behörde oder eines Gerichts verpflichtet sind; soweit zulässig, informieren wir den Kunden vorab. Die Pflichten dieses Paragrafen gelten nach Vertragsende fort, solange wir Kundeninhalte besitzen.",
      ],
    },
    {
      id: "de-agb-7",
      heading: "§ 7 Verfügbarkeit, Wartung und Support",
      blocks: [
        "(1) Wir betreiben den Dienst mit der Sorgfalt eines fachkundigen Anbieters. Eine bestimmte Verfügbarkeit sagen wir nicht zu. Der Dienst hängt von Leistungen Dritter ab, auf die wir keinen Einfluss haben, insbesondere von GitHub, den KI-Anbietern, unseren Hosting- und Zahlungsdienstleistern und dem Internet. Störungen dieser Dienste und höhere Gewalt gehen nicht zu unseren Lasten, soweit wir sie nicht zu vertreten haben.",
        "(2) Wir dürfen den Dienst für Wartung, Updates und Sicherheitsmaßnahmen vorübergehend einschränken; planbare längere Unterbrechungen kündigen wir nach Möglichkeit vorher an.",
        "(3) Einen Review, der wegen einer Störung nicht oder nicht vollständig gelaufen ist, kann der Kunde durch einen neuen Commit oder den Kommentar `/review` am Pull Request erneut auslösen.",
        "(4) Support erhält der Kunde per E-Mail an info@itegro-gmbh.de. Feste Reaktionszeiten sagen wir nicht zu.",
      ],
    },
    {
      id: "de-agb-8",
      heading: "§ 8 Guthaben und Zahlung",
      blocks: [
        "(1) Abrechnungsmodell: Die Preise für Reviews werden aus einem vorausbezahlten Guthaben des Workspace in US-Dollar (USD) beglichen. Es gibt keine Grundgebühr, kein Abonnement und keine automatische Aufladung.",
        "(2) Aufladen: Owner und Admins können das Guthaben aufladen. Eine Aufladung beträgt mindestens 10 USD und höchstens 500 USD. Gutgeschrieben wird der Betrag ohne Umsatzsteuer; anfallende Umsatzsteuer wird im Bezahlvorgang zusätzlich ausgewiesen und erhoben. Das Guthaben wird gutgeschrieben, sobald die Zahlung bestätigt ist.",
        "(3) Zahlungsabwicklung durch Stripe: Aufladungen werden über Stripe Managed Payments abgewickelt. Merchant of Record ist dabei Sold through Link, LLC, ein mit Stripe verbundenes Unternehmen (zusammen mit den übrigen beteiligten Gesellschaften der Stripe-Gruppe hier Stripe). Stripe tritt im Bezahlvorgang und auf Zahlungsbeleg und Rechnung im eigenen Namen auf, angezeigt als Sold through Link. Für die Zahlung gelten zusätzlich die im Bezahlvorgang angezeigten Bedingungen von Stripe. Stripe berechnet, erhebt und führt die Umsatzsteuer ab, soweit Stripe dafür nach seinen Bedingungen im Land des Kunden zuständig ist, und sendet Zahlungsbelege und Rechnungen per E-Mail an die im Bezahlvorgang angegebene Adresse; wo Stripe für die Umsatzsteuer nicht zuständig ist, stellt Stripe die Rechnung in unserem Namen aus. Form und Inhalt der Belege und Rechnungen richten sich nach den Vorgaben von Stripe; wir selbst stellen für Aufladungen keine gesonderte Rechnung aus. Die Reviews erbringt ausschließlich die Itegro GmbH; das Guthaben berechtigt den Kunden allein uns gegenüber, den Dienst im Wert des Guthabens zu nutzen. Für die steuerliche Behandlung beim Kunden, etwa den Vorsteuerabzug oder das Reverse-Charge-Verfahren, ist der Kunde verantwortlich.",
        "(4) Unternehmerbestätigung: Vor der ersten Aufladung bestätigt der Kunde in der Anwendung, dass er für ein Unternehmen und nicht als Verbraucher kauft, und gibt Firmenname und Anschrift sowie optional seine Umsatzsteuer-Identifikationsnummer an. Wir speichern die Bestätigung mit Zeitpunkt, handelnder Person und der Version dieser AGB.",
        "(5) Währung: Alle Beträge lauten auf USD. Zahlt der Kunde in einer anderen Währung, weil Stripe ihm den Preis in seiner Landeswährung anzeigt, rechnet Stripe um; Wechselkurse und Gebühren des Zahlungswegs gehen zu Lasten des Kunden. Das Guthaben lautet stets auf USD.",
        "(6) Eigenschaften des Guthabens: Guthaben ist eine Vorauszahlung für Reviews. Es gehört zum Workspace, hat keinen Barwert, wird nicht verzinst, kann nicht ausgezahlt und nicht auf andere Workspaces, Kunden oder Personen übertragen werden. Es verfällt nicht.",
        "(7) Keine Rückerstattung durch uns: Nicht verbrauchtes Guthaben erstatten wir nicht, auch nicht bei Kündigung oder bei Löschung des Kontos oder Workspace. Unberührt bleiben Ansprüche, die das Gesetz zwingend vorsieht, die Rechte, die Stripe dem Kunden als Merchant of Record nach seinen Bedingungen einräumt, sowie die Erstattung nach § 9 Abs. 7 und § 11 Abs. 5.",
        "(8) Erstattungen und Rückbuchungen: Stripe kann Zahlungen nach seinen Bedingungen erstatten, derzeit in bestimmten Fällen innerhalb von 60 Tagen nach der Zahlung, und Zahlungen bei Verdacht auf Betrug oder Missbrauch ablehnen, stornieren oder erstatten; außerdem können Zahlungen zurückgebucht werden. Wir buchen dann das zugehörige Guthaben ab. Ist es bereits verbraucht, wird der Saldo negativ; der Workspace bleibt für neue Reviews gesperrt, bis eine Aufladung den Saldo wieder über null hebt. Der Betrag, um den der Saldo negativ ist, bleibt als Entgelt für bereits erbrachte Reviews geschuldet; bei Vertragsende dürfen wir ihn gesondert in Rechnung stellen.",
        "(9) Startguthaben: Workspaces mit verbundener GitHub-Installation können ein Startguthaben erhalten, derzeit 2 USD, einmal je GitHub-Konto. Wir können Höhe und Gewährung ändern oder einstellen. Ein Anspruch auf Startguthaben besteht nicht. Bei Missbrauch (§ 4 Abs. 3) dürfen wir es entziehen.",
        "(10) Nutzung ohne Abrechnung: Wir können die Abrechnung für den Dienst insgesamt oder für einzelne Funktionen ein- oder ausschalten. Solange sie nicht eingeschaltet ist, wird der Dienst nicht berechnet, und es gelten die in der Anwendung angezeigten Begrenzungen. Vor dem Einschalten der Abrechnung informieren wir die Kunden mindestens 14 Tage im Voraus in Textform oder in der Anwendung über die Folgen.",
      ],
    },
    {
      id: "de-agb-9",
      heading: "§ 9 Preise",
      blocks: [
        "(1) Der Preis eines Reviews setzt sich aus den für den Review angefallenen KI-Kosten und der Laufzeit des Reviews (in Minuten) zusammen; beide werden jeweils mit einem Aufschlag berechnet, den wir nach billigem Ermessen (§ 315 BGB) festlegen. Den Preis jedes Reviews zeigt die Anwendung an; die Preise früherer Reviews kann der Kunde jederzeit in der Anwendung einsehen.",
        "(2) KI-Anteil: Er fällt nur an, wenn der Review mit unseren verwalteten Modellen läuft. Er bemisst sich nach den tatsächlichen KI-Kosten, die für den Review angefallen sind (Kosten, die der Modellanbieter zu seinen jeweils geltenden Preisen berechnet oder meldet), zuzüglich des Aufschlags. Läuft der Review mit einem eigenen Schlüssel des Kunden, fällt kein KI-Anteil an; den KI-Anbieter vergütet der Kunde dann unmittelbar nach dessen Bedingungen. Lässt sich die Höhe der KI-Kosten eines Reviews nicht feststellen, fällt für ihn kein KI-Anteil an.",
        "(3) Infrastrukturanteil: Er bemisst sich nach der Laufzeit des Reviews in angefangenen Minuten, zuzüglich des Aufschlags. Er fällt auch bei einem eigenen Schlüssel an. Einen Mindestpreis gibt es nicht.",
        "(4) Maßgeblich für die Abrechnung ist der endgültige Preis eines Reviews, den die Anwendung nach Abschluss des Reviews getrennt nach KI-Anteil und Infrastrukturanteil anzeigt (Übersicht der Reviews, Journal des Workspace). Der Preis steht erst nach Abschluss des Reviews fest.",
        "(5) Abbuchung: Der Preis wird bei Abschluss des Reviews vom Guthaben abgebucht und im Journal des Workspace gebucht. Ein Review startet, solange das Guthaben größer als null ist. Der Preis kann das Guthaben unter null senken; laufen mehrere Reviews gleichzeitig, kann der Saldo auch deutlich unter null fallen. Ein negativer Saldo ist nach § 8 Abs. 8 auszugleichen. Bei einem Guthaben von null oder darunter werden keine neuen Reviews gestartet; der Pull Request erhält einen Hinweis. Nach einer Aufladung kann der Kunde einen Review durch einen neuen Commit oder den Kommentar `/review` auslösen. Reviews, die mangels Guthabens nicht gestartet wurden, holen wir nicht nach.",
        "(6) Welche Reviews berechnet werden: Berechnet wird jeder gestartete Review zu dem in der Anwendung ausgewiesenen Preis, auch wenn er ohne Ergebnis, mit einem Fehler, nach Erreichen eines Limits, durch Abbruch oder deshalb endet, weil ein neuer Commit ihn überholt hat. Reviews, die nicht gestartet werden (leeres Guthaben, Monatslimit, Pause), werden nicht berechnet. Ob und in welcher Höhe für einen einzelnen Review ein Preis ausgewiesen wird, ergibt sich aus der Anwendung. Ein vertraglicher Anspruch darauf, dass ein bestimmter Review nicht berechnet wird, besteht nicht; wir können im Einzelfall und ohne Anerkennung einer Rechtspflicht Gutschriften gewähren. Gesetzliche Rechte des Kunden wegen Mängeln oder Pflichtverletzungen bleiben unberührt (§ 12 Abs. 9).",
        "(7) Preisänderungen: Ändert ein Modellanbieter seine Preise, ändern sich die KI-Kosten nach Absatz 2 und damit der KI-Anteil entsprechend; das ist keine Preisänderung im Sinne dieses Absatzes. Wir können die Aufschläge und die Berechnung des Preises jederzeit nach billigem Ermessen (§ 315 BGB) ändern, insbesondere um geänderte Kosten für Infrastruktur, Zahlungsabwicklung, Betrieb und Weiterentwicklung des Dienstes sowie die Marktentwicklung zu berücksichtigen. Eine Änderung gilt für Reviews, die nach ihrer Veröffentlichung in der Anwendung gestartet werden; eine Ankündigungsfrist besteht nicht. Über die Änderung informieren wir in der Anwendung oder in Textform. Erhöht eine Änderung die Preise, kann der Kunde den Vertrag jederzeit nach § 11 Abs. 1 kündigen; kündigt er innerhalb von 30 Tagen nach der Veröffentlichung der Änderung, erstatten wir ihm das bei Wirksamwerden der Kündigung vorhandene positive Guthaben nach § 11 Abs. 5. Preissenkungen gelten sofort.",
        "(8) Monatslimit: Owner und Admins können ein monatliches Ausgabenlimit festlegen. Haben die tatsächlichen Abbuchungen des laufenden Kalendermonats (UTC) das Limit erreicht, werden bis zum Monatsende keine neuen Reviews gestartet. Laufende Reviews werden zu Ende geführt und voll berechnet, auch wenn sie das Limit überschreiten. Das Limit begrenzt den Start neuer Reviews; ein Anspruch darauf, dass die Ausgaben das Limit nie übersteigen, besteht nicht.",
        "(9) Missbrauchsschutz: Wir dürfen begrenzen, wie viele Reviews ein Workspace in einem Zeitraum starten kann, und Reviews eines Workspace bei Verdacht auf Missbrauch zeitweise pausieren. Die Grenze nennen wir nicht. Die Pause heben wir auf, sobald der Verdacht ausgeräumt ist.",
        "(10) Einwendungen: Einwendungen gegen eine Buchung im Journal teilt der Kunde uns unverzüglich in Textform mit. Wir prüfen sie und korrigieren Fehler durch eine Korrekturbuchung. Mit Gegenforderungen kann der Kunde nur aufrechnen und ein Zurückbehaltungsrecht nur ausüben, wenn die Forderung unbestritten oder rechtskräftig festgestellt ist.",
      ],
    },
    {
      id: "de-agb-10",
      heading: "§ 10 Eigener KI-Schlüssel",
      blocks: [
        "(1) Der Kunde kann für seinen Workspace Schlüssel (API-Schlüssel) eigener KI-Anbieter aus dem Modellkatalog der Anwendung hinterlegen. Er sichert zu, zur Nutzung berechtigt zu sein, und trägt alle Kosten, Limits und Bedingungen aus dem Vertrag mit dem Anbieter. Wir haben auf den Anbieter keinen Einfluss und sind nicht Partei dieses Vertrags.",
        "(2) Wir speichern den Schlüssel verschlüsselt, zeigen ihn nach dem Speichern nicht mehr an und verwenden ihn nur für Reviews dieses Workspace. Der Kunde kann ihn jederzeit entfernen oder ersetzen und sollte ihn beim Anbieter widerrufen, wenn er einen Missbrauch vermutet.",
        "(3) Preise, Kontextgrößen und Modelllisten des Katalogs stammen von Dritten und sind unverbindliche Angaben. Kostenlimits und Tokenbegrenzungen der Anwendung für eigene Schlüssel sind Schutzmaßnahmen ohne Gewähr; sie können nicht ausschließen, dass beim Anbieter höhere Kosten entstehen als erwartet.",
        "(4) Bei einem eigenen Schlüssel fällt nur der Infrastrukturanteil an (§ 9 Abs. 3). Für Kosten oder Schäden beim KI-Anbieter haften wir nur nach § 12.",
      ],
    },
    {
      id: "de-agb-11",
      heading: "§ 11 Laufzeit, Kündigung, Sperrung und Beendigung",
      blocks: [
        "(1) Der Vertrag läuft auf unbestimmte Zeit. Der Kunde kann ihn jederzeit ohne Frist kündigen, in Textform an info@itegro-gmbh.de oder, soweit angeboten, in der Anwendung.",
        "(2) Wir können den Vertrag mit einer Frist von 30 Tagen kündigen. Das Recht beider Parteien zur außerordentlichen Kündigung aus wichtigem Grund (§ 314 BGB) bleibt unberührt. Ein wichtiger Grund für uns liegt insbesondere vor, wenn der Kunde wesentlich gegen § 4 verstößt, die Unternehmereigenschaft wahrheitswidrig bestätigt hat, wiederholt Zahlungen missbräuchlich zurückbucht oder einen negativen Saldo trotz Aufforderung mit angemessener Fristsetzung nicht ausgleicht.",
        "(3) Sperrung: Wir dürfen den Zugang eines Workspace oder Kontos ganz oder teilweise sperren und Reviews pausieren, wenn konkrete Anhaltspunkte für einen Verstoß gegen § 4, eine Gefahr für Sicherheit oder Integrität des Dienstes oder anderer Kunden, einen Rechtsverstoß oder einen Zahlungsmissbrauch vorliegen oder der Saldo negativ ist (§ 8 Abs. 8). Die Sperre beschränken wir auf das Erforderliche und heben sie auf, sobald der Grund entfallen ist. Wir informieren den Kunden unverzüglich, soweit dem keine Sicherheitsgründe entgegenstehen.",
        "(4) Folgen der Beendigung: Mit der Beendigung endet der Zugang zum Dienst. Der Kunde deinstalliert die GitHub-App in seinem GitHub-Konto selbst; die Ergebnisse früherer Reviews liegen als Kommentare bei GitHub in seinen Repositories. Wir löschen die Daten des Workspace (Konto, Projekte, Einstellungen, gespeicherte Schlüssel, Angaben zu Reviews) innerhalb angemessener Frist nach Vertragsende oder auf Verlangen des Kunden, soweit keine gesetzliche Aufbewahrungspflicht entgegensteht. Das Buchungsjournal und Abrechnungsunterlagen bewahren wir bis zum Ablauf der gesetzlichen Fristen auf und verwenden sie nur noch dafür (Datenschutzerklärung, Abschnitt 17). Einen Datenexport bieten wir nicht an.",
        "(5) Guthaben bei Beendigung: Für nicht verbrauchtes Guthaben gilt § 8 Abs. 7. Kündigen wir nach Absatz 2 Satz 1, stellen wir den Dienst dauerhaft ein, ohne dass der Kunde dazu Anlass gegeben hat, oder kündigt der Kunde innerhalb von 30 Tagen nach der Veröffentlichung einer Preiserhöhung (§ 9 Abs. 7), erstatten wir ihm das bei Vertragsende vorhandene positive Guthaben, soweit es nicht bereits erstattet oder zurückgebucht wurde. Die Erstattung erfolgt nach unserer Wahl über Stripe auf das ursprünglich verwendete Zahlungsmittel oder durch Überweisung auf ein Konto des Kunden.",
      ],
    },
    {
      id: "de-agb-12",
      heading: "§ 12 Haftung",
      blocks: [
        "(1) Wir haften unbeschränkt bei Vorsatz und grober Fahrlässigkeit, für Schäden aus der Verletzung des Lebens, des Körpers oder der Gesundheit, nach dem Produkthaftungsgesetz, bei arglistig verschwiegenen Mängeln, bei Übernahme einer Garantie und soweit das Gesetz sonst zwingend unbeschränkt haftet. In diesen Fällen gelten die Beschränkungen der folgenden Absätze nicht.",
        "(2) Bei einfach fahrlässiger Verletzung einer wesentlichen Vertragspflicht (Kardinalpflicht, also einer Pflicht, deren Erfüllung die ordnungsgemäße Durchführung des Vertrags erst ermöglicht und auf deren Einhaltung der Kunde regelmäßig vertrauen darf) ist die Haftung auf den bei Vertragsschluss vorhersehbaren, typischerweise eintretenden Schaden begrenzt. Für alle Schadensfälle eines Vertragsjahres zusammen ist sie in diesen Fällen außerdem auf den höheren der folgenden Beträge begrenzt: die Beträge, die der Kunde in den zwölf Monaten vor dem schadensbegründenden Ereignis für den Dienst gezahlt hat (Aufladungen ohne Umsatzsteuer), oder 5.000 USD. Vertragsjahr ist jeder Zeitraum von zwölf Monaten ab Vertragsschluss. Im Übrigen ist die Haftung bei einfacher Fahrlässigkeit ausgeschlossen.",
        "(3) Die verschuldensunabhängige Haftung für bei Vertragsschluss vorhandene Mängel (§ 536a Abs. 1 Alternative 1 BGB) ist ausgeschlossen.",
        "(4) Für den Verlust von Daten haften wir nur, wenn der Kunde seine Daten regelmäßig in angemessener Weise gesichert hat, und dann nur in Höhe des Aufwands, der bei regelmäßiger Sicherung für die Wiederherstellung angefallen wäre. Der Quellcode des Kunden liegt bei GitHub; wir sichern ihn nicht.",
        "(5) Wir haften nicht dafür, dass Reviews bestimmte Fehler finden oder ihre Hinweise richtig sind (§ 5), und nicht für Leistungen und Bedingungen Dritter, die nicht unsere Erfüllungsgehilfen sind, insbesondere GitHub und, bei einem eigenen Schlüssel, den gewählten KI-Anbieter. Die Absätze 1 bis 4 bleiben unberührt.",
        "(6) Schadensersatzansprüche des Kunden verjähren in einem Jahr ab dem gesetzlichen Verjährungsbeginn. Das gilt nicht in den Fällen des Absatzes 1.",
        "(7) Die Haftungsbeschränkungen gelten auch zugunsten unserer gesetzlichen Vertreter, Beschäftigten und Erfüllungsgehilfen.",
        "(8) Der Kunde haftet für Preise, die durch die Nutzung seines Workspace entstehen, bis zum Eingang seiner Meldung eines Missbrauchs bei uns, soweit er den Missbrauch zu vertreten hat.",
        "(9) Gesetzliche Rechte des Kunden, insbesondere bei Mängeln des Dienstes, bleiben unberührt, soweit diese AGB nichts anderes bestimmen.",
      ],
    },
    {
      id: "de-agb-13",
      heading: "§ 13 Datenschutz und Auftragsverarbeitung",
      blocks: [
        "(1) Informationen zur Verarbeitung personenbezogener Daten enthält die Datenschutzerklärung (code-review.com/privacy/).",
        "(2) Soweit wir bei der Erbringung des Dienstes personenbezogene Daten im Auftrag des Kunden verarbeiten, insbesondere personenbezogene Daten in Quellcode, Commits, Pull Requests und Kommentaren, ist der Kunde Verantwortlicher und wir sind Auftragsverarbeiter im Sinne des Art. 28 DSGVO. Dafür gelten die Absätze 3 bis 13, die mit Vertragsschluss Bestandteil des Vertrags werden. Bei Widersprüchen gehen sie den übrigen Regelungen dieser AGB vor.",
        "(3) Gegenstand, Dauer, Art und Zweck: Gegenstand ist die Verarbeitung der Kundeninhalte zur Durchführung von Reviews (Auslesen, Übermittlung an KI-Anbieter, Veröffentlichung der Ergebnisse, kurzzeitige technische Zwischenspeicherung). Die Dauer entspricht der Laufzeit des Vertrags. Arten von Daten sind Inhalte aus Repositories und Pull Requests (Quellcode, Kommentare, Namen und Kontaktangaben in Code und Commit-Angaben, GitHub-Logins). Betroffen sind Beschäftigte, Auftragnehmer, Mitwirkende und sonstige Personen, deren Daten in den Inhalten vorkommen. Der Kunde stellt sicher, dass besondere Kategorien personenbezogener Daten (Art. 9 DSGVO) nicht in den geprüften Inhalten enthalten sind oder ihre Verarbeitung zulässig ist.",
        "(4) Weisungen: Wir verarbeiten die Daten nur auf dokumentierte Weisung des Kunden. Die Weisung ergibt sich aus dem Vertrag und den Einstellungen des Kunden in der Anwendung, etwa der Auswahl der Repositories, der Review-Art und des Modells oder Anbieters. Weitere Weisungen sind in Textform zu erteilen und nur befolgbar, soweit sie im Rahmen des Dienstes liegen. Halten wir eine Weisung für rechtswidrig, weisen wir den Kunden darauf hin.",
        "(5) Vertraulichkeit: Wir verpflichten alle Personen, die zur Verarbeitung befugt sind, zur Vertraulichkeit.",
        "(6) Sicherheit: Wir treffen die in der Anlage beschriebenen technischen und organisatorischen Maßnahmen nach Art. 32 DSGVO und entwickeln sie weiter; das Schutzniveau unterschreiten wir dabei nicht.",
        "(7) Unterauftragsverarbeiter: Der Kunde erteilt eine allgemeine Genehmigung zum Einsatz weiterer Auftragsverarbeiter. Die bei Vertragsschluss eingesetzten nennt die Anlage. Wir informieren den Kunden mindestens 14 Tage vor einer Änderung in Textform oder in der Anwendung. Der Kunde kann der Änderung aus wichtigem datenschutzrechtlichem Grund widersprechen; kommt keine Einigung zustande, kann er den Vertrag zum Wirksamwerden der Änderung kündigen. Wir verpflichten Unterauftragsverarbeiter auf Pflichten, die den hier vereinbarten entsprechen. Bei einem eigenen Schlüssel ist der vom Kunden gewählte KI-Anbieter kein Unterauftragsverarbeiter von uns, sondern ein Dienstleister des Kunden.",
        "(8) Betroffenenrechte: Wir unterstützen den Kunden mit geeigneten technischen und organisatorischen Maßnahmen bei der Beantwortung von Anträgen betroffener Personen, soweit das möglich ist. Anträge, die uns erreichen und Daten des Kunden betreffen, leiten wir weiter.",
        "(9) Unterstützung: Wir unterstützen den Kunden bei den Pflichten nach Art. 32 bis 36 DSGVO, soweit uns die Informationen zugänglich sind. Eine Verletzung des Schutzes personenbezogener Daten melden wir dem Kunden unverzüglich, nachdem sie uns bekannt geworden ist.",
        "(10) Löschung: Nach Vertragsende löschen wir die im Auftrag verarbeiteten Daten (§ 11 Abs. 4), soweit keine gesetzliche Pflicht zur Speicherung besteht. Eine gesonderte Rückgabe erfolgt nicht, weil die Daten beim Kunden bei GitHub liegen.",
        "(11) Nachweise und Kontrollen: Wir stellen dem Kunden die Informationen zur Verfügung, die er zum Nachweis der Einhaltung der Pflichten aus Art. 28 DSGVO braucht, und ermöglichen Überprüfungen einschließlich Inspektionen, die der Kunde oder ein von ihm beauftragter, zur Verschwiegenheit verpflichteter Prüfer durchführt. Der Kunde kündigt Inspektionen rechtzeitig an und führt sie so durch, dass Betrieb und Vertraulichkeit gegenüber anderen Kunden nicht beeinträchtigt werden. Die Kosten trägt der Kunde, soweit nicht ein Verstoß festgestellt wird.",
        "(12) Drittländer: Eine Verarbeitung außerhalb der Europäischen Union und des Europäischen Wirtschaftsraums, insbesondere in den USA, erfolgt nur unter den Voraussetzungen der Art. 44 ff. DSGVO. Die Anlage nennt die jeweilige Grundlage.",
        "(13) Haftung: Die Haftung gegenüber betroffenen Personen nach Art. 82 DSGVO wird durch diese AGB nicht beschränkt. Im Verhältnis zwischen dem Kunden und uns, auch für den Ausgleich nach Art. 82 Abs. 5 DSGVO, gilt § 12.",
      ],
    },
    {
      id: "de-agb-14",
      heading: "§ 14 Änderungen dieser AGB",
      blocks: [
        "(1) Wir können diese AGB mit Wirkung für die Zukunft ändern, wenn es dafür einen sachlichen Grund gibt, etwa eine Gesetzesänderung, eine Änderung des Dienstes oder eine Anpassung an Bedingungen unserer Zahlungs- oder Hostingdienstleister, und die Änderung für den Kunden zumutbar ist.",
        "(2) Wir teilen Änderungen mindestens 14 Tage vor ihrem Wirksamwerden in Textform oder in der Anwendung mit und weisen auf die Folgen eines unterbliebenen Widerspruchs hin. Widerspricht der Kunde nicht innerhalb dieser Frist in Textform und nutzt er den Dienst nach Fristablauf weiter, gelten die Änderungen als genehmigt. Widerspricht er, gelten die bisherigen AGB weiter; wir können den Vertrag dann nach § 11 Abs. 2 Satz 1 kündigen (§ 11 Abs. 5 gilt).",
        "(3) Änderungen, die das Verhältnis von Leistung und Gegenleistung wesentlich zu unseren Gunsten verschieben oder dem Kunden zusätzliche wesentliche Pflichten auferlegen, werden nur mit ausdrücklicher Zustimmung des Kunden wirksam, etwa durch eine neue Bestätigung in der Anwendung. Preisänderungen richten sich allein nach § 9 Abs. 7; Absatz 2 gilt für sie nicht.",
      ],
    },
    {
      id: "de-agb-15",
      heading: "§ 15 Schlussbestimmungen",
      blocks: [
        "(1) Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts.",
        "(2) Ausschließlicher Gerichtsstand für alle Streitigkeiten aus oder im Zusammenhang mit dem Vertrag ist, soweit zulässig, unser Sitz in Geretsried. Wir dürfen den Kunden auch an seinem allgemeinen Gerichtsstand verklagen. Zwingende gesetzliche Gerichtsstände bleiben unberührt.",
        "(3) Mitteilungen an den Kunden dürfen wir an die im Konto hinterlegte E-Mail-Adresse oder in der Anwendung übermitteln. Der Kunde sorgt dafür, dass diese Adresse erreichbar ist.",
        "(4) Der Kunde darf Rechte und Pflichten aus dem Vertrag nur mit unserer Zustimmung übertragen; § 354a HGB bleibt unberührt. Wir dürfen Subunternehmer einsetzen.",
        "(5) Sind einzelne Bestimmungen unwirksam oder werden sie unwirksam, bleibt der Vertrag im Übrigen wirksam; an die Stelle der unwirksamen Bestimmung tritt die gesetzliche Regelung (§ 306 BGB).",
        "(6) Fragen zu diesen AGB beantworten wir unter info@itegro-gmbh.de.",
      ],
    },
    {
      id: "de-agb-anlage",
      heading: "Anlage zu § 13: Unterauftragsverarbeiter und technische und organisatorische Maßnahmen",
      blocks: [
        "1. Unterauftragsverarbeiter bei Vertragsschluss (Dienstleister, die im Auftrag Kundeninhalte verarbeiten):",
        {
          list: [
            "Vercel Inc., USA: Hosting der Anwendung und des Dispatchers sowie Ausführung der Reviews in virtuellen Maschinen (Vercel Sandbox) in der Region Frankfurt am Main. Verarbeitet werden alle Kundeninhalte während eines Reviews sowie Verbindungsdaten. Ein Zugriff aus den USA ist möglich; Grundlage ist der Angemessenheitsbeschluss zum EU-US Data Privacy Framework, soweit Vercel danach zertifiziert ist, im Übrigen sind es Standardvertragsklauseln.",
            "Neon, Inc., USA: verwaltete PostgreSQL-Datenbank in der Region Europe Central (AWS eu-central-1, Frankfurt am Main); die Daten werden in der Europäischen Union gespeichert. Verarbeitet werden Konto-, Workspace- und Abrechnungsdaten, Angaben zu Reviews und verschlüsselte Schlüssel, aber kein dauerhaft gespeicherter Quellcode. Ein Zugriff aus den USA ist möglich; Grundlage dafür sind der Angemessenheitsbeschluss zum EU-US Data Privacy Framework, soweit Neon danach zertifiziert ist, im Übrigen Standardvertragsklauseln.",
            "Anthropic PBC, USA, und, soweit eingerichtet, OpenRouter, Inc., USA: KI-Modelle der verwalteten Betriebsart. Verarbeitet werden die Auszüge der Kundeninhalte, die je Review übermittelt werden (§ 6 Abs. 4). Grundlage sind die Standardvertragsklauseln der Vertragsbedingungen des jeweiligen Anbieters oder der Angemessenheitsbeschluss zum EU-US Data Privacy Framework, soweit der Anbieter zertifiziert ist.",
            "Resend, Inc., USA: Versand von System-E-Mails der Anwendung (Einladungen, Anmelde- und Benachrichtigungs-E-Mails, Hinweise zum Guthaben). Verarbeitet werden E-Mail-Adresse, Name und der Inhalt der Nachricht. Ein Zugriff aus den USA ist möglich; Grundlage ist der Angemessenheitsbeschluss zum EU-US Data Privacy Framework, soweit Resend danach zertifiziert ist, im Übrigen sind es Standardvertragsklauseln.",
          ],
        },
        "Nicht Unterauftragsverarbeiter sind GitHub (Quelle der Repositories, vom Kunden genutzt), Stripe (Merchant of Record und Zahlungsabwickler, eigener Verantwortlicher) und der vom Kunden bei einem eigenen Schlüssel gewählte KI-Anbieter.",
        "2. Technische und organisatorische Maßnahmen:",
        {
          list: [
            "Zugang und Zugriff: Anmeldung erforderlich; Passwörter mit mindestens 12 Zeichen und Abgleich mit einer Liste häufiger Passwörter; Begrenzung von Anmeldeversuchen; serverseitig geprüfte Sitzungen mit 30 Tagen Gültigkeit; Rollen je Workspace (Owner, Admin, Member); Zugriffe sind auf die Daten des jeweiligen Workspace beschränkt.",
            "Übertragung: verschlüsselt per TLS zwischen Browser, Anwendung, Datenbank, GitHub und KI-Anbietern; Webhooks von GitHub und Stripe werden anhand ihrer Signatur geprüft.",
            "Isolation: Jeder Review läuft in einer frischen, nicht dauerhaften virtuellen Maschine, die aus einem Abbild ohne Kundendaten erzeugt wird, in einem gehärteten Container; das GitHub-Zugriffstoken eines Reviews ist kurzlebig und auf ein Repository beschränkt.",
            "Schlüssel und Geheimnisse: Hinterlegte API-Schlüssel und Zugangstoken werden verschlüsselt gespeichert und nach dem Speichern nicht mehr angezeigt; Zugangsdaten werden in Protokollen und Ergebnissen unkenntlich gemacht; Zugangsdaten unserer Infrastruktur liegen in einem Secret-Manager, die Bereitstellung läuft über geprüfte Pipelines.",
            "Protokollierung und Integrität: Betriebsprotokolle enthalten keine Kundeninhalte; Buchungen im Journal sind unveränderlich.",
            "Datenminimierung und Löschung: Quellcode wird nicht dauerhaft gespeichert; Löschfristen nennt die Datenschutzerklärung, Abschnitt 17.",
            "Organisation: Zugriff von Beschäftigten nur bei Bedarf und mit Verpflichtung zur Vertraulichkeit; Meldeweg für Sicherheitslücken über GitHub Security Advisories.",
          ],
        },
      ],
    },
  ],
};

export const TERMS_EN: LegalDocument = {
  lang: "en",
  title: "Terms of service (English translation)",
  dateLabel: `Last updated: ${TERMS_DATE.en}`,
  note: `Version ${TERMS_VERSION} · The German version above is the binding one.`,
  sections: [
    {
      id: "en-terms-1",
      heading: "§ 1 Scope, provider, businesses only",
      blocks: [
        "(1) The provider of the service code-review.com is Itegro GmbH, Buchberger Straße 10c, 82538 Geretsried, Germany (we). These terms of service apply to all contracts between us and our customers on the use of the hosted application at app.code-review.com and the related services (together the service), including use without billing, the start credit and use with an own AI key.",
        "(2) The service is aimed exclusively at businesses within the meaning of § 14 of the German Civil Code (BGB) and at legal entities under public law and special funds under public law. We do not offer the service to consumers (§ 13 BGB). Before the first top up of credit, the customer expressly confirms that it acts as a business and warrants that it uses the service only for commercial or independent professional purposes. Anyone who confirms business status untruthfully bears the resulting disadvantages; in that case we may terminate the contract for good cause (§ 11 (2)).",
        "(3) Conflicting or deviating terms of the customer do not apply, even if we do not expressly object to them. Deviating agreements require our confirmation in text form.",
        "(4) The contract language is German. The English version is for information only; if they differ, the German version prevails.",
      ],
    },
    {
      id: "en-terms-2",
      heading: "§ 2 Services",
      blocks: [
        "(1) The service reviews pull requests on GitHub with the help of AI models (reviews) and publishes the result as a comment, review and check run on the pull request. There are two kinds of reviews: the Diff Review, which checks the changes of a pull request, and the Dynamic Review, in which an AI agent examines the repository in read only mode. We also provide a web application in which the customer manages workspaces, projects, settings, keys, credit and reviews.",
        "(2) The scope of services follows from the description of the service on code-review.com and in the application at the time the contract is concluded. We carry out the reviews with the care of a competent provider, using AI models of third parties; we do not owe a particular review result (§ 5).",
        "(3) We may develop and change the service, in particular functions, interface, kinds of reviews, models and providers used and the technical infrastructure, provided that the purpose of the contract is not substantially impaired and the change is reasonable for the customer. When using our managed models, the customer has no claim to a particular model or model provider.",
        "(4) Functions marked as preview, beta or in development are provided without any commitment to availability or stability; we may change or discontinue them at any time.",
        "(5) Per workspace, the customer uses the service in one of two modes: with our managed models (price made up of an AI part and an infrastructure part, § 9) or with an own key at an AI provider of its choice (infrastructure part only, § 10). The customer chooses the mode in the application.",
      ],
    },
    {
      id: "en-terms-3",
      heading: "§ 3 Account, workspace and conclusion of the contract",
      blocks: [
        "(1) The customer creates an account in the application and creates or joins a workspace. Sign in is through GitHub or, where offered, with an email address and password. The contracting party is the company for which the workspace is created. Anyone who creates a workspace or tops up credit declares that they are entitled to represent that company.",
        "(2) The contract is concluded when we accept the registration, at the latest when the account or workspace is activated. There is no claim to the conclusion of a contract; we may reject registrations.",
        "(3) The customer gives truthful information at registration and in the billing details and keeps it up to date, in particular company name, address, VAT ID and email address. Disadvantages from false or outdated information, for example on receipts and invoices, are at the customer's expense.",
        "(4) The customer is responsible for its credentials and for everything its members do in its workspace. It keeps credentials secret, assigns the roles (Owner, Admin, Member) with care, removes members who have left and informs us without delay of misuse or suspected misuse. Owners and Admins may represent the customer towards us, top up credit and change settings.",
      ],
    },
    {
      id: "en-terms-4",
      heading: "§ 4 Duties of the customer",
      blocks: [
        "(1) The customer ensures that it is entitled to apply the service to the repositories it selects and to have their content processed by us and our service providers and transmitted to the chosen AI provider. In doing so it observes rights of third parties, license terms, confidentiality obligations towards its own clients and data protection requirements. It installs the GitHub App only on repositories for which it is authorized to do so.",
        "(2) The customer is responsible for not including content that must not or should not be transmitted to an AI provider (such as credentials, keys or particularly sensitive personal data) in repositories or pull requests that the service reviews, or for not enabling those repositories for the service.",
        "(3) In particular, the customer refrains from:",
        {
          list: [
            "using the service for unlawful content or acts or in a way that infringes rights of third parties",
            "attacks on the service, its infrastructure or other customers, in particular attempts to break out of the isolation of the review environment, to read out credentials or to steer the models for purposes unrelated to reviewing its own repository",
            "circumventing limits, abuse protection or billing, in particular creating several accounts or workspaces to obtain the start credit more than once",
            "passing on credentials to unauthorized persons",
            "excessive automated requests that impair operation for other customers",
          ],
        },
        "(4) If the customer breaches these duties, we may block access under § 11 (3). The customer indemnifies us against claims of third parties based on a culpable breach by the customer of paragraph 1 or 3 and reimburses us for the reasonable costs of legal defence.",
      ],
    },
    {
      id: "en-terms-5",
      heading: "§ 5 AI results",
      blocks: [
        "(1) The reviews are generated by AI models. They may be wrong, incomplete or misleading, may miss errors or report problems that are none. We do not promise that a review finds particular or all errors, security vulnerabilities or violations of licenses or law, that its remarks are correct or that a pull request is free of errors after the review.",
        "(2) A review replaces neither examination by qualified persons nor tests, security audits or legal and tax advice. The customer decides at its own responsibility whether and how to act on remarks and whether to merge changes. This also applies to ratings set by the service itself, such as an approval or the result of a check run.",
        "(3) The contractual quality of the service is that the reviews are carried out in line with the state of the art (§ 2 (2)), not the substantive correctness or completeness of the results.",
        "(4) We claim no rights in the results of a review; the customer may use them freely. We cannot rule out that results resemble content of third parties; the customer checks them before adopting them.",
      ],
    },
    {
      id: "en-terms-6",
      heading: "§ 6 Confidentiality and handling of source code",
      blocks: [
        "(1) The source code, the pull requests and all other content the customer has processed through the service (customer content) remain with the customer or its right holders. The customer grants us the non exclusive, non transferable right to process the customer content, to transmit it to the service providers and AI providers used for the review and to publish the results on the pull request, as far as necessary to provide the service.",
        "(2) We treat customer content as confidential. We access repositories in read only mode and only to carry out reviews, we write no code to repositories, and for each review we use a short lived access token limited to a single repository. Reviews run in fresh, non persistent virtual machines in the region Frankfurt am Main, which are ended after the review. We do not store source code permanently. For each review we store metadata, usage data and a limited technical log excerpt (privacy policy, section 12).",
        "(3) Our staff and service providers get access to customer content only as far as necessary to provide the service, to fix errors and to fend off abuse and security incidents, and are bound to confidentiality.",
        "(4) Passing data to AI providers: the customer knows and accepts that for each review excerpts of the customer content (in particular changed lines, file contents, file names, descriptions and comments of the pull request, information on commits and project instructions) are transmitted to the chosen AI provider. For the managed models these are the providers we use, at present Anthropic PBC and, where set up, OpenRouter, Inc., both USA. With an own key it is the provider the customer chooses; the contractual relationship is then between the customer and that provider, whose terms, also on storage, use and training, apply, and we transmit the content on the customer's instructions. The customer is responsible for choosing a provider whose terms are suitable for its content.",
        "(5) No training: we do not use customer content and the answers of the AI models to train or improve models and do not pass them on to third parties for that purpose. We may evaluate technical usage data without customer content, such as token counts, durations and error codes, for billing, operation, security and further development of the service.",
        "(6) Confidentiality does not apply to information that is generally known or becomes so without our doing, nor to disclosures we are obliged to make by law or by decision of an authority or court; where permitted, we inform the customer beforehand. The duties of this section continue after the end of the contract as long as we hold customer content.",
      ],
    },
    {
      id: "en-terms-7",
      heading: "§ 7 Availability, maintenance and support",
      blocks: [
        "(1) We operate the service with the care of a competent provider. We do not promise a particular availability. The service depends on services of third parties over which we have no influence, in particular GitHub, the AI providers, our hosting and payment providers and the internet. Disruptions of these services and force majeure are not at our expense unless we are responsible for them.",
        "(2) We may restrict the service temporarily for maintenance, updates and security measures; we announce longer planned interruptions in advance where possible.",
        "(3) A review that did not run, or did not run completely, because of a disruption can be triggered again by the customer with a new commit or the comment `/review` on the pull request.",
        "(4) The customer gets support by email at info@itegro-gmbh.de. We do not promise fixed response times.",
      ],
    },
    {
      id: "en-terms-8",
      heading: "§ 8 Credit and payment",
      blocks: [
        "(1) Billing model: the prices of reviews are paid from a prepaid credit of the workspace in US dollars (USD). There is no base fee, no subscription and no automatic recharge.",
        "(2) Top up: Owners and Admins can top up the credit. A top up is at least 10 USD and at most 500 USD. The amount credited is the amount without VAT; any VAT is shown and charged additionally at checkout. The credit is added as soon as the payment is confirmed.",
        "(3) Payment processing by Stripe: top ups are processed through Stripe Managed Payments. The merchant of record is Sold through Link, LLC, a company affiliated with Stripe (together with the other companies of the Stripe group involved, here Stripe). Stripe acts in its own name in the checkout and on the receipt and invoice, shown as Sold through Link. The terms of Stripe shown at checkout apply to the payment in addition. Stripe calculates, collects and remits the VAT where Stripe is responsible for it in the customer's country under its terms, and sends payment receipts and invoices by email to the address given at checkout; where Stripe is not responsible for the VAT, Stripe issues the invoice in our name. The form and content of receipts and invoices follow the rules of Stripe; we do not issue separate invoices ourselves for top ups. The reviews are provided solely by Itegro GmbH; the credit entitles the customer solely towards us to use the service to the value of the credit. The customer is responsible for its own tax treatment, for example input VAT deduction or the reverse charge procedure.",
        "(4) Business confirmation: before the first top up, the customer confirms in the application that it buys for a business and not as a consumer, and provides company name and address and optionally its VAT ID. We store the confirmation with the time, the acting person and the version of these terms.",
        "(5) Currency: all amounts are in USD. If the customer pays in another currency because Stripe shows it the price in its local currency, Stripe converts; exchange rates and fees of the payment method are at the customer's expense. The credit is always in USD.",
        "(6) Nature of the credit: credit is a prepayment for reviews. It belongs to the workspace, has no cash value, bears no interest, cannot be paid out and cannot be transferred to other workspaces, customers or persons. It does not expire.",
        "(7) No refund by us: we do not refund unused credit, not even on termination or on deletion of the account or workspace. Unaffected are claims that the law mandatorily provides for, the rights that Stripe grants the customer as merchant of record under its terms, and the refund under § 9 (7) and § 11 (5).",
        "(8) Refunds and chargebacks: Stripe may refund payments under its terms, currently in certain cases within 60 days of the payment, and may decline, cancel or refund payments on suspicion of fraud or abuse; payments may also be charged back. We then deduct the corresponding credit. If it has already been used, the balance becomes negative; the workspace stays blocked for new reviews until a top up raises the balance above zero again. The amount by which the balance is negative remains owed as the price for reviews already provided; at the end of the contract we may invoice it separately.",
        "(9) Start credit: workspaces with a connected GitHub installation can receive a start credit, currently 2 USD, once per GitHub account. We may change or discontinue the amount and the granting. There is no claim to a start credit. In case of abuse (§ 4 (3)) we may withdraw it.",
        "(10) Use without billing: we may switch billing on or off for the service as a whole or for individual functions. As long as it is not switched on, the service is not charged, and the limits shown in the application apply. Before switching billing on, we inform customers at least 14 days in advance in text form or in the application of the consequences.",
      ],
    },
    {
      id: "en-terms-9",
      heading: "§ 9 Prices",
      blocks: [
        "(1) The price of a review is made up of the AI costs incurred for the review and the runtime of the review (in minutes); each is charged with a markup that we set at our reasonable discretion (§ 315 BGB). The application shows the price of every review; the customer can look up the prices of earlier reviews in the application at any time.",
        "(2) AI part: it arises only if the review runs on our managed models. It is based on the actual AI costs incurred for the review (the costs the model provider charges or reports at its prices in force at the time), plus the markup. If the review runs on an own key of the customer, there is no AI part; the customer then pays the AI provider directly under that provider's terms. If the amount of the AI costs of a review cannot be determined, no AI part arises for it.",
        "(3) Infrastructure part: it is based on the runtime of the review in started minutes, plus the markup. It also arises with an own key. There is no minimum price.",
        "(4) What counts for billing is the final price of a review that the application shows after the review has finished, split into the AI part and the infrastructure part (list of reviews, journal of the workspace). The price is only known once the review has finished.",
        "(5) Charging: the price is deducted from the credit when the review finishes and booked in the journal of the workspace. A review starts as long as the credit is greater than zero. The price can take the credit below zero; if several reviews run at the same time, the balance can fall well below zero. A negative balance is to be settled under § 8 (8). With a balance of zero or below, no new reviews are started; the pull request receives a notice. After a top up, the customer can trigger a review with a new commit or the comment `/review`. We do not catch up on reviews that were not started for lack of credit.",
        "(6) Which reviews are charged: every started review is charged at the price shown in the application, even if it ends without a result, with an error, after reaching a limit, by being cancelled or because a new commit has superseded it. Reviews that are not started (empty balance, monthly limit, pause) are not charged. Whether and in what amount a price is shown for an individual review follows from the application. There is no contractual claim that a particular review is not charged; in individual cases and without acknowledging a legal obligation we may grant credits. Statutory rights of the customer for defects or breaches of duty remain unaffected (§ 12 (9)).",
        "(7) Price changes: if a model provider changes its prices, the AI costs under paragraph 2 and thus the AI part change accordingly; this is not a price change within the meaning of this paragraph. We may change the markups and the calculation of the price at any time at our reasonable discretion (§ 315 BGB), in particular to take account of changed costs of infrastructure, payment processing, operation and further development of the service and of market developments. A change applies to reviews started after it has been published in the application; there is no notice period. We inform about the change in the application or in text form. If a change increases prices, the customer may terminate the contract at any time under § 11 (1); if it terminates within 30 days of the publication of the change, we refund the positive credit available when the termination takes effect, under § 11 (5). Price reductions apply immediately.",
        "(8) Monthly limit: Owners and Admins can set a monthly spending limit. Once the actual charges of the current calendar month (UTC) have reached the limit, no new reviews are started until the end of the month. Running reviews are finished and charged in full, even if they exceed the limit. The limit restricts the start of new reviews; there is no claim that spending will never exceed the limit.",
        "(9) Abuse protection: we may limit how many reviews a workspace can start in a period and may pause the reviews of a workspace temporarily on suspicion of abuse. We do not disclose the limit. We lift the pause as soon as the suspicion is dispelled.",
        "(10) Objections: the customer notifies us of objections to an entry in the journal without delay in text form. We examine them and correct errors by a correcting entry. The customer may set off counterclaims and exercise a right of retention only if the claim is undisputed or finally determined by a court.",
      ],
    },
    {
      id: "en-terms-10",
      heading: "§ 10 Own AI key",
      blocks: [
        "(1) For its workspace, the customer can store keys (API keys) of its own AI providers from the model catalog of the application. It warrants that it is entitled to use them and bears all costs, limits and terms of the contract with the provider. We have no influence on the provider and are not a party to that contract.",
        "(2) We store the key encrypted, do not show it again after saving and use it only for reviews of that workspace. The customer can remove or replace it at any time and should revoke it at the provider if it suspects misuse.",
        "(3) Prices, context sizes and model lists of the catalog come from third parties and are non binding. Cost limits and token limits of the application for own keys are protective measures without guarantee; they cannot rule out that higher costs arise at the provider than expected.",
        "(4) With an own key, only the infrastructure part arises (§ 9 (3)). We are liable for costs or damage at the AI provider only under § 12.",
      ],
    },
    {
      id: "en-terms-11",
      heading: "§ 11 Term, termination, blocking and end of the contract",
      blocks: [
        "(1) The contract runs for an indefinite period. The customer can terminate it at any time without notice, in text form to info@itegro-gmbh.de or, where offered, in the application.",
        "(2) We can terminate the contract with 30 days' notice. The right of both parties to terminate for good cause (§ 314 BGB) remains unaffected. Good cause for us exists in particular if the customer materially breaches § 4, has confirmed business status untruthfully, repeatedly charges back payments abusively or does not settle a negative balance despite a request with a reasonable deadline.",
        "(3) Blocking: we may block access of a workspace or account in whole or in part and pause reviews if there are concrete indications of a breach of § 4, a danger to the security or integrity of the service or of other customers, a violation of law or payment abuse, or if the balance is negative (§ 8 (8)). We limit the block to what is necessary and lift it as soon as the reason has ceased. We inform the customer without delay unless security reasons prevent this.",
        "(4) Consequences of the end: access to the service ends with the end of the contract. The customer uninstalls the GitHub App in its own GitHub account; the results of earlier reviews are in its repositories at GitHub as comments. We delete the data of the workspace (account, projects, settings, stored keys, information on reviews) within a reasonable period after the end of the contract or at the customer's request, unless a statutory retention obligation prevents this. We keep the booking journal and billing records until the statutory periods have expired and use them only for that purpose (privacy policy, section 17). We do not offer a data export.",
        "(5) Credit at the end: for unused credit, § 8 (7) applies. If we terminate under paragraph 2 sentence 1, permanently discontinue the service without the customer having given cause for it, or if the customer terminates within 30 days of the publication of a price increase (§ 9 (7)), we refund the positive credit available at the end of the contract, as far as it has not already been refunded or charged back. At our choice, the refund is made through Stripe to the payment method originally used or by bank transfer to an account of the customer.",
      ],
    },
    {
      id: "en-terms-12",
      heading: "§ 12 Liability",
      blocks: [
        "(1) We are liable without limitation for intent and gross negligence, for damage from injury to life, body or health, under the Product Liability Act, for defects fraudulently concealed, when we have given a guarantee and where the law otherwise mandatorily provides for unlimited liability. In these cases the limitations in the following paragraphs do not apply.",
        "(2) In case of simple negligent breach of an essential contractual duty (cardinal duty, that is, a duty whose fulfilment makes proper performance of the contract possible in the first place and on whose observance the customer may regularly rely), liability is limited to the damage foreseeable at the time the contract was concluded and typical for this kind of contract. For all cases of damage in a contract year together, it is in these cases also limited to the higher of the following amounts: the amounts the customer paid for the service in the twelve months before the event causing the damage (top ups without VAT), or 5,000 USD. A contract year is each period of twelve months from the conclusion of the contract. Otherwise, liability for simple negligence is excluded.",
        "(3) Strict liability for defects existing at the time the contract was concluded (§ 536a (1) alternative 1 BGB) is excluded.",
        "(4) We are liable for the loss of data only if the customer has regularly backed up its data in an appropriate way, and then only to the extent of the effort that restoring would have caused with regular backups. The customer's source code is at GitHub; we do not back it up.",
        "(5) We are not liable for reviews finding particular errors or their remarks being correct (§ 5), nor for services and terms of third parties who are not our vicarious agents, in particular GitHub and, with an own key, the chosen AI provider. Paragraphs 1 to 4 remain unaffected.",
        "(6) Claims of the customer for damages become time barred one year after the statutory start of the limitation period. This does not apply in the cases of paragraph 1.",
        "(7) The limitations of liability also apply in favour of our legal representatives, employees and vicarious agents.",
        "(8) The customer is liable for prices arising from the use of its workspace until we receive its report of misuse, as far as it is responsible for the misuse.",
        "(9) Statutory rights of the customer, in particular for defects of the service, remain unaffected unless these terms provide otherwise.",
      ],
    },
    {
      id: "en-terms-13",
      heading: "§ 13 Data protection and data processing",
      blocks: [
        "(1) Information on the processing of personal data is in the privacy policy (code-review.com/privacy/).",
        "(2) Where we process personal data on behalf of the customer while providing the service, in particular personal data in source code, commits, pull requests and comments, the customer is the controller and we are the processor within the meaning of Art. 28 GDPR. Paragraphs 3 to 13 apply to this and become part of the contract when it is concluded. In case of conflict they take precedence over the other provisions of these terms.",
        "(3) Subject matter, duration, nature and purpose: the subject matter is the processing of the customer content to carry out reviews (reading, transmission to AI providers, publication of the results, short term technical intermediate storage). The duration corresponds to the term of the contract. Types of data are content from repositories and pull requests (source code, comments, names and contact details in code and commit information, GitHub logins). Data subjects are employees, contractors, contributors and other persons whose data appears in the content. The customer ensures that special categories of personal data (Art. 9 GDPR) are not contained in the reviewed content or that their processing is lawful.",
        "(4) Instructions: we process the data only on documented instructions of the customer. The instructions follow from the contract and the customer's settings in the application, such as the selection of repositories, the kind of review and the model or provider. Further instructions are to be given in text form and can be followed only within the scope of the service. If we consider an instruction unlawful, we point this out to the customer.",
        "(5) Confidentiality: we bind all persons authorized to process to confidentiality.",
        "(6) Security: we take the technical and organizational measures described in the annex under Art. 32 GDPR and develop them further; we do not fall below the level of protection.",
        "(7) Sub processors: the customer gives a general authorization to engage further processors. The annex names those engaged when the contract is concluded. We inform the customer at least 14 days before a change in text form or in the application. The customer may object to the change for an important reason under data protection law; if no agreement is reached, it may terminate the contract as of the date the change takes effect. We bind sub processors to duties corresponding to those agreed here. With an own key, the AI provider chosen by the customer is not a sub processor of ours but a service provider of the customer.",
        "(8) Rights of data subjects: we support the customer with suitable technical and organizational measures in answering requests of data subjects, as far as possible. Requests that reach us and concern the customer's data we forward.",
        "(9) Support: we support the customer with the duties under Art. 32 to 36 GDPR as far as the information is accessible to us. We report a personal data breach to the customer without undue delay after becoming aware of it.",
        "(10) Deletion: after the end of the contract we delete the data processed on behalf (§ 11 (4)), unless a statutory duty to store applies. There is no separate return, because the data is with the customer at GitHub.",
        "(11) Evidence and audits: we provide the customer with the information it needs to demonstrate compliance with the duties under Art. 28 GDPR and allow audits including inspections carried out by the customer or an auditor appointed by it who is bound to confidentiality. The customer announces inspections in good time and carries them out so that operation and confidentiality towards other customers are not impaired. The customer bears the costs unless a breach is found.",
        "(12) Third countries: processing outside the European Union and the European Economic Area, in particular in the USA, takes place only under the conditions of Art. 44 et seq. GDPR. The annex names the respective basis.",
        "(13) Liability: liability towards data subjects under Art. 82 GDPR is not limited by these terms. Between the customer and us, including recourse under Art. 82 (5) GDPR, § 12 applies.",
      ],
    },
    {
      id: "en-terms-14",
      heading: "§ 14 Changes to these terms",
      blocks: [
        "(1) We may change these terms with effect for the future if there is a factual reason for it, such as a change in law, a change of the service or an adjustment to terms of our payment or hosting providers, and the change is reasonable for the customer.",
        "(2) We notify changes at least 14 days before they take effect, in text form or in the application, and point out the consequences of not objecting. If the customer does not object in text form within that period and keeps using the service after the period has expired, the changes are deemed approved. If it objects, the previous terms continue to apply; we may then terminate the contract under § 11 (2) sentence 1 (§ 11 (5) applies).",
        "(3) Changes that shift the balance of performance and consideration materially in our favour or impose additional material duties on the customer take effect only with the customer's express consent, for example by a new confirmation in the application. Price changes are governed solely by § 9 (7); paragraph 2 does not apply to them.",
      ],
    },
    {
      id: "en-terms-15",
      heading: "§ 15 Final provisions",
      blocks: [
        "(1) German law applies, excluding the UN Convention on Contracts for the International Sale of Goods.",
        "(2) The exclusive place of jurisdiction for all disputes arising from or in connection with the contract is, where permissible, our registered seat in Geretsried. We may also sue the customer at its general place of jurisdiction. Mandatory statutory places of jurisdiction remain unaffected.",
        "(3) We may send notices to the customer to the email address stored in the account or in the application. The customer ensures that this address is reachable.",
        "(4) The customer may transfer rights and duties under the contract only with our consent; § 354a HGB remains unaffected. We may use subcontractors.",
        "(5) If individual provisions are or become invalid, the contract remains valid otherwise; the statutory rule replaces the invalid provision (§ 306 BGB).",
        "(6) We answer questions on these terms at info@itegro-gmbh.de.",
      ],
    },
    {
      id: "en-terms-annex",
      heading: "Annex to § 13: sub processors and technical and organizational measures",
      blocks: [
        "1. Sub processors when the contract is concluded (service providers that process customer content on behalf):",
        {
          list: [
            "Vercel Inc., USA: hosting of the application and the Dispatcher and running of the reviews in virtual machines (Vercel Sandbox) in the region Frankfurt am Main. All customer content is processed during a review, as well as connection data. Access from the USA is possible; the basis is the adequacy decision on the EU-US Data Privacy Framework where Vercel is certified under it, and otherwise standard contractual clauses.",
            "Neon, Inc., USA: managed PostgreSQL database in the region Europe Central (AWS eu-central-1, Frankfurt am Main); the data is stored in the European Union. Account, workspace and billing data, information on reviews and encrypted keys are processed, but no permanently stored source code. Access from the USA is possible; the basis for it is the adequacy decision on the EU-US Data Privacy Framework where Neon is certified under it, and otherwise standard contractual clauses.",
            "Anthropic PBC, USA, and, where set up, OpenRouter, Inc., USA: AI models of the managed mode. The excerpts of customer content transmitted per review are processed (§ 6 (4)). The basis is the standard contractual clauses in the terms of the respective provider or the adequacy decision on the EU-US Data Privacy Framework where the provider is certified.",
            "Resend, Inc., USA: sending system emails of the application (invitations, sign-in and notification emails, credit notices). Email address, name and the content of the message are processed. Access from the USA is possible; the basis is the adequacy decision on the EU-US Data Privacy Framework where Resend is certified under it, and otherwise standard contractual clauses.",
          ],
        },
        "Not sub processors are GitHub (source of the repositories, used by the customer), Stripe (merchant of record and payment processor, a controller in its own right) and the AI provider chosen by the customer with an own key.",
        "2. Technical and organizational measures:",
        {
          list: [
            "Access: sign in required; passwords of at least 12 characters checked against a list of common passwords; limits on sign in attempts; server side checked sessions valid for 30 days; roles per workspace (Owner, Admin, Member); access is limited to the data of the respective workspace.",
            "Transmission: encrypted with TLS between browser, application, database, GitHub and AI providers; webhooks from GitHub and Stripe are checked by their signature.",
            "Isolation: every review runs in a fresh, non persistent virtual machine created from an image without customer data, in a hardened container; the GitHub access token of a review is short lived and limited to one repository.",
            "Keys and secrets: stored API keys and access tokens are stored encrypted and are not shown again after saving; credentials are made unreadable in logs and results; credentials of our infrastructure are kept in a secrets manager and deployment runs through reviewed pipelines.",
            "Logging and integrity: operational logs contain no customer content; entries in the journal cannot be changed.",
            "Data minimization and deletion: source code is not stored permanently; retention periods are in the privacy policy, section 17.",
            "Organization: staff access only where needed and bound to confidentiality; reporting route for vulnerabilities through GitHub Security Advisories.",
          ],
        },
      ],
    },
  ],
};
