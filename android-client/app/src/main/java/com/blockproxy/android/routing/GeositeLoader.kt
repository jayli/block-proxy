package com.blockproxy.android.routing

import android.content.Context
import android.util.Log

/**
 * Loads and parses the geosite.dat protobuf file from Android assets.
 * The file is in Xray/V2Ray GeoSiteList format.
 *
 * GeoSiteList (top-level message)
 *   field 1 (length-delimited, repeated): GeoSite
 *     field 1 (string): country_code
 *     field 2 (length-delimited, repeated): Domain
 *       field 1 (varint): type (0=plain, 1=regex, 2=domain, 3=full)
 *       field 2 (string): value
 */
class GeositeLoader {

    companion object {
        private const val TAG = "GeositeLoader"
        private const val GEOSITE_ASSET_PATH = "geodata/geosite.dat"
    }

    /**
     * Load and parse geosite.dat from assets.
     * Returns a map of country_code → list of DomainRule.
     * Country codes are lowercased.
     */
    fun load(context: Context): Map<String, List<DomainRule>> {
        return try {
            val data = context.assets.open(GEOSITE_ASSET_PATH).use { it.readBytes() }
            parseGeositeData(data)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load geosite.dat", e)
            emptyMap()
        }
    }

    /**
     * Parse geosite protobuf data. Exposed for testing without Android context.
     */
    fun parseGeositeData(data: ByteArray): Map<String, List<DomainRule>> {
        val result = mutableMapOf<String, List<DomainRule>>()
        val topFields = ProtoParser.parseMessage(data)

        for (field in topFields) {
            if (field.fieldNumber != 1 || field.wireType != 2) continue
            val siteBytes = field.value as ByteArray
            val siteFields = ProtoParser.parseMessage(siteBytes)

            val countryCode = ProtoParser.getString(siteFields, 1, "")?.lowercase() ?: continue
            if (countryCode.isEmpty()) continue

            val domains = mutableListOf<DomainRule>()
            for (sf in siteFields) {
                if (sf.fieldNumber != 2 || sf.wireType != 2) continue
                val domainBytes = sf.value as ByteArray
                val domainFields = ProtoParser.parseMessage(domainBytes)

                val typeValue = ProtoParser.getVarint(domainFields, 1, 0L)?.toInt() ?: 0
                val domainType = DomainType.fromProto(typeValue)
                val domainValue = ProtoParser.getString(domainFields, 2, "") ?: continue

                if (domainValue.isNotEmpty()) {
                    domains.add(DomainRule(domainType, domainValue))
                }
            }

            if (domains.isNotEmpty()) {
                result[countryCode] = domains
            }
        }

        return result
    }
}
