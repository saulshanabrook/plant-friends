//
//  ContentView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/1/22.
//

import SwiftUI

struct ContentView: View {
    @StateObject var resp = res;
    var body: some View {
        switch resp.value {
        case nil:
            ProgressView()
        default:
            NavigationView{
                List(resp.value!) { plant in
                    NavigationLink {
                        DetailView(plant: plant)
                    } label: {
                        VStack(alignment: .leading){
                            Text(plant.latin_name)
                            Text(plant.common_names.joined(separator: ", ")).font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                                .foregroundColor(.secondary)
                            
                            
                        }
                    }
                }.navigationTitle("Plants")
            }
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
