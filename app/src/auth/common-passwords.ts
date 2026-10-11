// The bundled list of common passwords (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.2). The minimum length is 12, so only passwords that reach it matter: the longest entries of the
// well-known leaked lists, keyboard walks, number runs, and the well-known words that people pad
// with digits to get past a length rule (see `isCommonPassword` in password-policy.ts, which also
// strips such padding). Lower case; the check lower-cases and normalizes the password first.

/** Whole passwords that are refused as they are. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  `
  123456789012 1234567890123 12345678901234 123456789012345 1234567890123456
  12345678910 123456789123 111111111111 222222222222 000000000000 999999999999
  123123123123 123456123456 112233445566 102030405060 147258369147 147258369258
  987654321098 098765432109 123456654321 12345678900987654321 1122334455667788
  abcdefghijkl abcdefghijklm abcdefghijklmn abcdefghijklmnop abcdefghijklmnopqrstuvwxyz
  abcabcabcabc abc123abc123 abcd12345678 abcd1234abcd
  qwertyuiop12 qwertyuiop123 qwertyuiopasdf qwertyuiopasdfghjkl qwertyuiop[]
  qwertyuiopasdfghjklzxcvbnm asdfghjkl123 asdfghjklqwerty asdfghjklasdfghjkl
  qwerty123456 qwerty1234567 qwerty12345678 qwertyqwerty qwertyuiop1234
  qwertyuiop123456 qwertyasdfgh qwerty123qwerty zxcvbnm12345 zxcvbnmasdfgh
  1qaz2wsx3edc 1qaz2wsx3edc4rfv 1q2w3e4r5t6y 1q2w3e4r5t6y7u 1q2w3e4r5t6y7u8i
  1qazxsw23edc 1qaz1qaz1qaz zaq12wsxcde3 qazwsxedcrfv qazwsxedc123 q1w2e3r4t5y6
  qwe123qwe123 qweasdzxc123 qweasdzxcqwe asdasdasdasd asdf1234asdf asdfasdfasdf
  password1234 password12345 password123456 password1234567 password12345678
  passwordpassword password1password passwordpassword1 mypassword123 mypassword1234
  mypassword12345 thepassword123 newpassword123 newpassword1234 yourpassword123
  passw0rd1234 passw0rd12345 passw0rdpassw0rd p@ssw0rd1234 p@ssword1234
  p@ssw0rd12345 p@ssword12345 p4ssw0rd1234 pa55word1234 pa$$word1234
  iloveyou1234 iloveyou12345 iloveyou123456 iloveyouiloveyou iloveyou2000
  letmein12345 letmein123456 letmeinletmein welcome12345 welcome123456
  welcome1234567 welcomewelcome welcome2020 welcome2021 welcome2022 welcome2023
  welcome2024 welcome2025 welcome2026
  administrator administrator1 administrator12 administrator123 adminadmin123
  admin12345678 admin1234567 admin123456 adminadminadmin changeme1234
  changeme12345 changemechangeme changeme123456 default12345 defaultdefault
  football1234 football12345 baseball1234 baseball12345 basketball123
  superman1234 superman12345 spiderman123 batman123456 starwars1234 pokemon12345
  princess1234 princess12345 sunshine1234 sunshine12345 trustno1trustno1
  monkey123456 dragon123456 master123456 shadow123456 michael123456
  jennifer1234 jordan123456 charlie12345 liverpool123 manchester123
  summer2020 summer2021 summer2022 summer2023 summer2024 summer2025 summer2026
  winter2020 winter2021 winter2022 winter2023 winter2024 winter2025 winter2026
  spring2020 spring2021 spring2022 spring2023 spring2024 spring2025 spring2026
  autumn2020 autumn2021 autumn2022 autumn2023 autumn2024 autumn2025 autumn2026
  company12345 companypassword secretpassword secret123456 testtesttest1
  test12345678 testpassword1 testing12345 testtesttesttest letmeinplease
  correcthorsebatterystaple thequickbrownfox thequickbrownfoxjumps
  loveloveloves lovelovelove1 iloveyouforever ilovemyself123 ilovemylife123
  hello1234567 helloworld123 helloworld1234 hellohello123 helloworldhello
  000000000000000 111111111111111 aaaaaaaaaaaa aaaaaaaaaaaaa bbbbbbbbbbbb
  codereview123 codereviewer1 codereviewer123 code-reviewer1 octestra12345
  `
    .split(/\s+/)
    .filter((word) => word !== ""),
);

/**
 * Well-known passwords that people lengthen with digits or a few symbols at the end
 * (`password` + `2024!`). A password that is one of these followed by nothing but such padding is
 * refused, however long the padding is.
 */
export const COMMON_BASES: ReadonlySet<string> = new Set(
  `
  password passw0rd p@ssword p@ssw0rd pa55word pa$$word qwerty qwertyuiop
  asdfghjkl zxcvbnm letmein welcome iloveyou admin administrator changeme
  football baseball basketball superman batman spiderman starwars pokemon
  princess sunshine monkey dragon master shadow michael jennifer jordan
  charlie liverpool manchester trustno secret default hello helloworld
  testing test summer winter spring autumn company abc abcdef abcdefgh
  `
    .split(/\s+/)
    .filter((word) => word !== ""),
);
