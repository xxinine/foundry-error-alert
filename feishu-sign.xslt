<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:msxsl="urn:schemas-microsoft-com:xslt"
  xmlns:signer="urn:feishu-sign"
  exclude-result-prefixes="msxsl signer">
  <xsl:output method="xml" omit-xml-declaration="yes" encoding="utf-8" />
  <msxsl:script language="C#" implements-prefix="signer">
    <msxsl:using namespace="System" />
    <msxsl:using namespace="System.Text" />
    <msxsl:using namespace="System.Security.Cryptography" />
    <![CDATA[
    public string Sign(string timestamp, string secretBase64) {
      string secret = Encoding.UTF8.GetString(Convert.FromBase64String(secretBase64));
      byte[] key = Encoding.UTF8.GetBytes(timestamp + "\n" + secret);
      using (HMACSHA256 hmac = new HMACSHA256(key)) {
        return Convert.ToBase64String(hmac.ComputeHash(new byte[0]));
      }
    }
    ]]>
  </msxsl:script>
  <xsl:template match="/request">
    <signature><xsl:value-of select="signer:Sign(string(timestamp), string(secretBase64))" /></signature>
  </xsl:template>
</xsl:stylesheet>