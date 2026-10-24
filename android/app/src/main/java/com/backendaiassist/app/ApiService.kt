import retrofit2.Response
import retrofit2.http.GET

interface ApiService {
    @GET("/")
    suspend fun getHome(): Response<Map<String, Any>>
}
